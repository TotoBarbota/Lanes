import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/config/load.mjs';
import { classifyChanges, parseStatusZ } from '../src/git/repo.mjs';
import { lanePorts } from '../src/project/ports.mjs';
import { rewriteValue } from '../src/stack/compose.mjs';
import { renderRouterConf } from '../src/router/nginx.mjs';
import { renderGuide } from '../src/agents/guide.mjs';
import { buildFingerprints } from '../src/stack/buildcache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'shop', 'lanes.yml');
process.env.LANES_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-test-'));
const p = loadProject({ configFile: FIXTURE });

function withConfig(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-cfg-'));
  const f = path.join(dir, 'lanes.yml');
  fs.writeFileSync(f, text);
  return () => loadProject({ configFile: f });
}

test('config: defaults are filled in', () => {
  assert.equal(p.name, 'shop');
  assert.equal(p.compose.project, 'shop');
  assert.equal(p.lanes.max, 5);
  assert.deepEqual(p.services.orders.paths, ['services/orders']);
  assert.deepEqual(p.services.gateway.paths, ['gateway']);
  assert.equal(p.services.worker.route, false);
  assert.equal(p.services.orders.heap.lane, '768m');
  assert.equal(p.routing.baggageKey, 'lane');
});

test('config: errors name the key and what is expected', () => {
  const base = 'name: x\nrepo: .\nrefs: { baseline: a, laneBase: b }\n';
  assert.throws(withConfig(`${base}services: { api: { port: 0 } }`), /"services\.api\.port" must be the container port/);
  assert.throws(withConfig('name: Bad Name\n'), /"name" must be a short id/);
  assert.throws(withConfig('name: x\nrepo: .\nservices: { api: { port: 1 } }'), /"refs" must set/);
  assert.throws(withConfig(`${base}services: { api: { port: 8080, cors: { uis: [nope], env: X } } }`), /unknown UI "nope"/);
  assert.throws(withConfig(`${base}lanes: { max: 9, portStride: 10000 }\nservices: { api: { port: 8080 } }`), /must stay below 65536/);
  assert.throws(withConfig(`${base}services: { api: { port: 8080 } }\ndata: { db: { dump: x } }`), /"data\.db" needs dump and restore/);
  const withData = withConfig(`${base}services: { api: { port: 8080 } }\ndata: { db: { dump: d, restore: r } }`)();
  assert.deepEqual(withData.data.db, { service: 'db', dump: 'd', restore: 'r', ext: 'dump' });
});

test('config: lanes.local.yml overrides lanes.yml; repo comes from the link when omitted', async () => {
  const { linkConfig } = await import('../src/config/load.mjs');
  const { cmdAgents } = await import('../src/commands/onboard.mjs');
  const { run } = await import('../src/core/exec.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-repo-'));
  run('git', ['init', '-q'], { cwd: repo });
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-cfg-'));
  const f = path.join(cfgDir, 'lanes.yml');
  fs.writeFileSync(f, [
    'name: team', 'refs: { baseline: main, laneBase: main }', 'services: { api: { port: 8080 } }',
    'dashboard: { port: 7070 }', 'agents: { skill: { name: team-lanes, description: Use for team services } }', '',
  ].join('\n'));
  assert.throws(() => loadProject({ configFile: f }), /"repo" is required when lanes\.yml is outside the repository and not linked/);
  linkConfig(repo, f);
  assert.equal(fs.realpathSync.native(loadProject({ configFile: f }).repo), fs.realpathSync.native(repo));

  fs.writeFileSync(path.join(cfgDir, 'lanes.local.yml'), 'dashboard: { port: 7171 }\nworktree: { dir: ./wt }\n');
  const local = loadProject({ configFile: f });
  assert.equal(local.dashboard.port, 7171);
  assert.equal(local.worktree.dir, path.join(cfgDir, 'wt'));
  assert.equal(local.services.api.port, 8080);
  assert.ok(local.localConfigFile.endsWith('lanes.local.yml'));

  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-skills-'));
  await cmdAgents(local, [], { skill: true, dir: skills });
  const skill = fs.readFileSync(path.join(skills, 'team-lanes', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: team-lanes\r?\ndescription: Use for team services\r?\n---/);
  assert.match(skill, /lanes\.mjs" guide/);
});

test('change detection maps files to services, UIs and shared folders', () => {
  const r = classifyChanges(p, [
    'services/orders/src/main/java/A.java',
    'services/orders/src/test/java/ATest.java',
    'gateway/Dockerfile',
    'web/src/app.tsx',
    'libs/common/Util.java',
    'README.md',
    'docker-compose.yml',
    'gateway/app.local.properties',
  ]);
  assert.deepEqual(r.services, ['gateway', 'orders']);
  assert.deepEqual(r.uis, ['web']);
  assert.deepEqual(r.shared.map((s) => s.path), ['libs/common']);
  assert.deepEqual(r.other, ['docker-compose.yml']);
});

test('git status output yields edited, untracked and both sides of renamed files', () => {
  const out = ' M gateway/App.java\0?? web/new file.ts\0R  orders/New.java\0orders/Old.java\0D  catalog/Gone.java\0';
  assert.deepEqual(parseStatusZ(out), ['gateway/App.java', 'web/new file.ts', 'orders/New.java', 'orders/Old.java', 'catalog/Gone.java']);
  assert.deepEqual(parseStatusZ(''), []);
});

test('build fingerprints change only for services whose visible files changed', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-wt-'));
  const put = (f, text) => {
    fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
    fs.writeFileSync(path.join(wt, f), text);
  };
  const files = ['services/orders/A.java', 'web/app.tsx', 'libs/common/U.java', 'gateway/app.local.properties', 'pom.xml'];
  for (const f of files) put(f, 'v1');
  const compose = { services: Object.fromEntries(['gateway', 'orders', 'catalog'].map((s) => [`k-${s}`, { build: { context: '.' } }])) };
  const fp = (dirty) => buildFingerprints(p, { worktree: wt, head: 'abc', dirty, protectedFiles: ['gateway/app.local.properties'], compose, keyOf: (s) => `k-${s}` });

  let prev = fp(files);
  assert.deepEqual(Object.keys(prev).sort(), ['catalog', 'gateway', 'orders']);
  assert.deepEqual(fp(files), prev);
  const changed = (f, text) => {
    put(f, text);
    const after = fp(files);
    const diff = Object.keys(prev).filter((s) => prev[s] !== after[s]).sort();
    prev = after;
    return diff;
  };
  assert.deepEqual(changed('services/orders/A.java', 'v22'), ['orders']);
  assert.deepEqual(changed('web/app.tsx', 'v22'), []);
  assert.deepEqual(changed('gateway/app.local.properties', 'v2'), ['gateway']);
  assert.deepEqual(changed('libs/common/U.java', 'v22'), ['catalog', 'gateway', 'orders']);
  assert.deepEqual(changed('pom.xml', 'v22'), ['catalog', 'gateway', 'orders']);
});

test('lane ports add N x stride to base ports', () => {
  const l2 = lanePorts(p, 2);
  assert.deepEqual(l2.entry, { gateway: 28080 });
  assert.deepEqual(l2.ui, { web: 23000 });
  assert.equal(l2.debug('orders'), 25081);
});

test('service URLs are rewritten to the router only for routed host:port pairs', () => {
  const targets = new Set(['orders:8081', 'shop-orders-1:8081']);
  assert.equal(rewriteValue('http://orders:8081/api', targets), 'http://lane-router:8081/api');
  assert.equal(rewriteValue('orders:8081', targets), 'lane-router:8081');
  assert.equal(rewriteValue('http://shop-orders-1:8081', targets), 'http://lane-router:8081');
  assert.equal(rewriteValue('http://orders:9999', targets), 'http://orders:9999');
  assert.equal(rewriteValue('http://myorders:8081', targets), 'http://myorders:8081');
  assert.equal(rewriteValue('a=orders:8081,b=orders:80812', targets), 'a=lane-router:8081,b=orders:80812');
});

test('router config sends each lane to its own copies and everything else to the baseline', () => {
  const reg = {
    lanes: {
      bugx: { name: 'bugx', number: 1, services: ['orders'], status: 'running' },
      feat: { name: 'feat', number: 2, services: ['gateway', 'orders'], status: 'running' },
    },
  };
  const conf = renderRouterConf(p, reg);
  assert.match(conf, /map \$lanes_lane \$lanes_up_orders \{\n {2}default "orders:8081";\n {2}"bugx" "lane-bugx-orders:8081";\n {2}"feat" "lane-feat-orders:8081";\n\}/);
  assert.match(conf, /map \$lanes_lane \$lanes_up_gateway \{\n {2}default "gateway:8080";\n {2}"feat" "lane-feat-gateway:8080";\n\}/);
  assert.match(conf, /listen 18080;\n {2}set \$lanes_lane "bugx";/);
  assert.match(conf, /listen 28080;\n {2}set \$lanes_lane "feat";/);
  assert.match(conf, /listen 38080;\n {2}location \/ \{ default_type text\/plain; return 503/);
  assert.match(conf, /"~\^https\?:\/\/\(localhost\|127\\\.0\\\.0\\\.1\):23000\$" "feat";/);
  assert.match(conf, /"~\*\(\?:\^\|\[,;\\s\]\)lane=\(\[a-z0-9-\]\+\)" \$1;/);
  assert.doesNotMatch(conf, /listen 8083/);
  assert.doesNotMatch(conf, /worker/);
});

test('the agent guide is specific to the project', () => {
  const g = renderGuide(p);
  assert.match(g, /# Running and testing changes in shop with lanes/);
  assert.match(g, /gateway entry \| 8080 \| 18080 \| 28080/);
  assert.match(g, /Web UI dev server \| 3000 \| 13000 \| 23000/);
  assert.match(g, /baggage: lane=<lane>/);
  assert.match(g, /\*\.local\.properties/);
});
