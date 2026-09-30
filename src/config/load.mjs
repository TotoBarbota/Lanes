import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { run } from '../core/exec.mjs';
import { UsageError, readJson, writeJson, isPlainObject, deepMerge } from '../core/util.mjs';
import { homeDir, samePath } from '../platform/index.mjs';

export const CONFIG_NAMES = ['lanes.yml', 'lanes.yaml', '.lanes/lanes.yml'];

export function lanesHome() {
  return process.env.LANES_HOME ? path.resolve(process.env.LANES_HOME) : path.join(homeDir(), '.lanes');
}

const linksFile = () => path.join(lanesHome(), 'links.json');

/** Git facts for a directory, or null when it is not inside a repository. */
const repoCache = new Map();

export function gitRepoOf(dir) {
  const key = path.resolve(dir);
  if (repoCache.has(key)) return repoCache.get(key);
  const r = run('git', ['rev-parse', '--show-toplevel', '--git-common-dir'], { cwd: dir, allowFail: true });
  let info = null;
  if (r.ok) {
    const [top, common] = r.stdout.trim().split(/\r?\n/);
    const commonDir = path.resolve(top, common);
    const mainCheckout = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
    info = { top: path.normalize(top), commonDir, mainCheckout };
  }
  repoCache.set(key, info);
  return info;
}

/**
 * Links a repository to a lanes.yml kept outside of it, for teams that don't want the file in
 * the repo. The link is keyed by the repo's shared git dir, so it covers every worktree.
 */
export function linkConfig(repoDir, configFile) {
  const repo = gitRepoOf(repoDir);
  if (!repo) throw new UsageError(`${repoDir} is not inside a git repository.`);
  const links = readJson(linksFile(), {});
  links[repo.commonDir] = path.resolve(configFile);
  writeJson(linksFile(), links);
  return repo;
}

/** Main checkout of the repository that `lanes link` attached to this config file, if any. */
function linkedRepoOf(configFile) {
  const links = readJson(linksFile(), {});
  const common = Object.keys(links).find((c) => samePath(links[c], configFile));
  return common && path.basename(common) === '.git' ? path.dirname(common) : null;
}

function findConfigFile(cwd) {
  if (process.env.LANES_CONFIG) return path.resolve(process.env.LANES_CONFIG);
  const repo = gitRepoOf(cwd);
  if (!repo) return null;
  for (const dir of [repo.top, repo.mainCheckout].filter(Boolean)) {
    for (const n of CONFIG_NAMES) {
      const f = path.join(dir, n);
      if (fs.existsSync(f)) return f;
    }
  }
  const links = readJson(linksFile(), {});
  for (const [common, file] of Object.entries(links)) if (samePath(common, repo.commonDir)) return file;
  return null;
}

// ---------------------------------------------------------------- validation helpers

class ConfigError extends UsageError {}

function need(cond, file, key, msg) {
  if (!cond) throw new ConfigError(`${file}: "${key}" ${msg}`);
}

const str = (v) => typeof v === 'string' && v.length > 0;
const port = (v) => Number.isInteger(v) && v > 0 && v < 65536;
const strList = (v) => Array.isArray(v) && v.every(str);
const strMap = (v) => isPlainObject(v) && Object.values(v).every((x) => ['string', 'number', 'boolean'].includes(typeof x));
const stringifyValues = (m) => Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k, String(v)]));

const DEFAULT_IGNORE = ['*.md', '**/src/test/**', '**/__tests__/**', '*.test.*', '*.spec.*'];

function normalizeService(name, raw, file, java) {
  const key = `services.${name}`;
  need(isPlainObject(raw), file, key, 'must be a mapping');
  const route = raw.route !== false;
  if (route) need(port(raw.port), file, `${key}.port`, 'must be the container port the service listens on (1-65535)');
  const runtime = raw.runtime ?? 'none';
  need(['java', 'none'].includes(runtime), file, `${key}.runtime`, 'must be "java" or "none" (other runtimes are planned)');
  const paths = raw.paths ?? [raw.path ?? name];
  need(strList(paths), file, `${key}.paths`, 'must be a list of repo-relative folders');
  const jobsOff = raw.jobsOff ?? {};
  need(isPlainObject(jobsOff), file, `${key}.jobsOff`, 'must be a mapping with env and/or spring');
  if (jobsOff.env) need(strMap(jobsOff.env), file, `${key}.jobsOff.env`, 'must map names to values');
  if (jobsOff.spring) need(isPlainObject(jobsOff.spring), file, `${key}.jobsOff.spring`, 'must map Spring property names to values');
  if (raw.laneEnv) need(strMap(raw.laneEnv), file, `${key}.laneEnv`, 'must map names to values');
  let cors = null;
  if (raw.cors) {
    need(isPlainObject(raw.cors), file, `${key}.cors`, 'must be a mapping');
    need(strList(raw.cors.uis ?? []), file, `${key}.cors.uis`, 'must list UI keys');
    need(str(raw.cors.springProperty) || str(raw.cors.env), file, `${key}.cors`, 'needs springProperty or env (where the origin list goes)');
    cors = {
      uis: raw.cors.uis ?? [],
      springProperty: raw.cors.springProperty ?? null,
      env: raw.cors.env ?? null,
      from: raw.cors.from ?? [],
      default: raw.cors.default ?? '',
    };
  }
  const heap = { baseline: raw.heap?.baseline ?? java.heap.baseline, lane: raw.heap?.lane ?? java.heap.lane };
  return {
    name,
    route,
    port: route ? raw.port : null,
    entry: !!raw.entry,
    runtime,
    paths: paths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, '')),
    laneEnv: stringifyValues(raw.laneEnv),
    jobsOff: { env: stringifyValues(jobsOff.env), spring: jobsOff.spring ?? {} },
    jobsNote: raw.jobsNote ?? null,
    cors,
    heap,
  };
}

function normalizeUi(key, raw, file) {
  const k = `uis.${key}`;
  need(isPlainObject(raw), file, k, 'must be a mapping');
  need(str(raw.path), file, `${k}.path`, 'must be the UI folder, relative to the repo root');
  need(port(raw.port), file, `${k}.port`, 'must be the port the baseline UI runs on');
  need(str(raw.command), file, `${k}.command`, 'must be the dev server command, e.g. "npm run dev -- --port {{port}}"');
  if (raw.env) need(strMap(raw.env), file, `${k}.env`, 'must map names to values');
  if (raw.laneEnv) need(strMap(raw.laneEnv), file, `${k}.laneEnv`, 'must map names to values');
  if (raw.reuseInstall !== undefined) need(typeof raw.reuseInstall === 'boolean', file, `${k}.reuseInstall`, 'must be true or false');
  return {
    key,
    label: raw.label ?? key,
    path: raw.path.replace(/\\/g, '/').replace(/\/+$/, ''),
    port: raw.port,
    command: raw.command,
    install: raw.install ?? 'auto',
    installedMarker: raw.installedMarker ?? 'node_modules',
    reuseInstall: raw.reuseInstall ?? true,
    seedFromMain: raw.seedFromMain ?? [],
    env: stringifyValues(raw.env),
    laneEnv: stringifyValues(raw.laneEnv),
    memoryGb: raw.memoryGb ?? 2,
  };
}

function normalize(raw, file) {
  need(isPlainObject(raw), file, '(root)', 'must be a mapping');
  need(str(raw.name) && /^[a-z0-9][a-z0-9-]*$/.test(raw.name), file, 'name', 'must be a short id: lower-case letters, digits and dashes');
  const configDir = path.dirname(file);

  // A committed lanes.yml is read from whichever worktree you're in, so `repo` (default: the
  // config's own repository, else the one linked to it) is always resolved to the main checkout.
  const repoDir = raw.repo ? path.resolve(configDir, raw.repo) : gitRepoOf(configDir) ? configDir : linkedRepoOf(file);
  need(repoDir, file, 'repo', 'is required when lanes.yml is outside the repository and not linked to it (run "lanes link <lanes.yml>" in the repo)');
  const r = gitRepoOf(repoDir);
  const repo = r?.mainCheckout || repoDir;

  need(isPlainObject(raw.refs), file, 'refs', 'must set baseline and laneBase');
  need(str(raw.refs.baseline), file, 'refs.baseline', 'must be the ref the baseline stack runs, e.g. origin/main');
  need(str(raw.refs.laneBase), file, 'refs.laneBase', 'must be the ref task branches start from, e.g. origin/main');

  const compose = raw.compose ?? {};
  need(strList(compose.files ?? ['docker-compose.yml']), file, 'compose.files', 'must list compose files relative to the repo root');

  const javaRaw = raw.runtimes?.java ?? {};
  const java = {
    agentVersion: javaRaw.agentVersion ?? '2.31.1',
    agentPath: javaRaw.agentPath ? path.resolve(configDir, javaRaw.agentPath) : null,
    heap: { baseline: javaRaw.heap?.baseline ?? '768m', lane: javaRaw.heap?.lane ?? '768m' },
    memOverheadMb: javaRaw.memOverheadMb ?? 640,
    debugPort: javaRaw.debugPort ?? 5005,
    springDefaults: javaRaw.springDefaults !== false,
  };

  need(isPlainObject(raw.services) && Object.keys(raw.services).length, file, 'services', 'must list at least one service');
  const services = {};
  for (const [name, s] of Object.entries(raw.services)) services[name] = normalizeService(name, s, file, java);
  const uis = {};
  for (const [key, u] of Object.entries(raw.uis ?? {})) uis[key] = normalizeUi(key, u, file);
  for (const s of Object.values(services)) {
    for (const u of s.cors?.uis ?? []) need(uis[u], file, `services.${s.name}.cors.uis`, `names unknown UI "${u}"`);
  }

  const lanes = { max: raw.lanes?.max ?? 5, portStride: raw.lanes?.portStride ?? 10000 };
  need(Number.isInteger(lanes.max) && lanes.max >= 1 && lanes.max <= 9, file, 'lanes.max', 'must be 1-9');
  const highest = Math.max(...Object.values(services).map((s) => s.port ?? 0), ...Object.values(uis).map((u) => u.port));
  need(lanes.portStride * lanes.max + highest < 65536, file, 'lanes.portStride', `x lanes.max + the highest port (${highest}) must stay below 65536`);

  const data = {};
  for (const [svc, d] of Object.entries(raw.data ?? {})) {
    need(isPlainObject(d) && str(d.dump) && str(d.restore), file, `data.${svc}`, 'needs dump and restore commands (run inside the container; dump writes to stdout, restore reads stdin)');
    data[svc] = { service: svc, dump: d.dump, restore: d.restore, ext: d.ext ?? 'dump' };
  }

  const routing = raw.routing ?? {};
  const worktree = raw.worktree ?? {};
  const agents = raw.agents ?? {};
  if (agents.skill) {
    need(isPlainObject(agents.skill) && str(agents.skill.name) && /^[a-z0-9][a-z0-9-]*$/.test(agents.skill.name), file, 'agents.skill.name', 'must be a short id: lower-case letters, digits and dashes');
    need(str(agents.skill.description), file, 'agents.skill.description', 'must say when agents should use the skill');
  }
  const home = path.join(lanesHome(), 'projects', raw.name);

  return {
    name: raw.name,
    configFile: file,
    configDir,
    repo: path.normalize(repo),
    refs: { baseline: raw.refs.baseline, laneBase: raw.refs.laneBase },
    compose: {
      files: compose.files ?? ['docker-compose.yml'],
      project: compose.project ?? raw.name,
      exclude: compose.exclude ?? [],
      overrides: compose.overrides ?? {},
    },
    lanes,
    routing: {
      baggageKey: routing.baggageKey ?? 'lane',
      cookie: routing.cookie ?? 'lane',
      header: routing.header ?? 'X-Lane',
    },
    services,
    uis,
    shared: (raw.shared ?? []).map((s) => (typeof s === 'string' ? { path: s, note: '' } : { path: s.path, note: s.note ?? '' })),
    detect: { ignore: [...DEFAULT_IGNORE, ...(raw.detect?.ignore ?? [])] },
    data,
    worktree: {
      setup: worktree.setup ?? null,
      teardown: worktree.teardown ?? null,
      protect: worktree.protect ?? [],
      sparse: worktree.sparse ?? null,
      dir: worktree.dir ? path.resolve(configDir, worktree.dir) : path.join(home, 'worktrees'),
    },
    runtimes: { java },
    memory: {
      minHostFreeGb: raw.memory?.minHostFreeGb ?? 4,
      maxDockerPercent: raw.memory?.maxDockerPercent ?? 90,
    },
    dashboard: { port: Number(process.env.LANES_DASHBOARD_PORT) || raw.dashboard?.port || 7070 },
    agents: {
      command: agents.command ?? null,
      localFiles: (agents.localFiles ?? []).map((f) => (typeof f === 'string' ? { path: f } : f)),
      notes: agents.notes ?? [],
      skill: agents.skill ? { name: agents.skill.name, description: agents.skill.description, template: agents.skill.template ?? 'skill' } : null,
    },
    paths: {
      home,
      state: path.join(home, 'state'),
      registry: path.join(home, 'state', 'lanes.json'),
      baselineState: path.join(home, 'state', 'baseline.json'),
      generated: path.join(home, 'generated'),
      routerDir: path.join(home, 'generated', 'router'),
      baselineCompose: path.join(home, 'generated', 'baseline.compose.json'),
      lanesDir: path.join(home, 'generated', 'lanes'),
      logs: path.join(home, 'logs'),
      snapshots: path.join(home, 'snapshots'),
      hooks: path.join(home, 'hooks'),
      baselineWorktree: worktree.baselineDir ? path.resolve(configDir, worktree.baselineDir) : path.join(home, 'baseline'),
      cache: path.join(lanesHome(), 'cache'),
    },
  };
}

export function loadProject({ cwd = process.cwd(), configFile } = {}) {
  const file = configFile ? path.resolve(configFile) : findConfigFile(cwd);
  if (!file) {
    throw new UsageError(
      'No lanes.yml found for this repository. Run "lanes init" in the repo to create one, '
        + 'or "lanes link <path-to-lanes.yml>" to use one kept outside the repo.',
    );
  }
  if (!fs.existsSync(file)) throw new UsageError(`Config file not found: ${file}`);
  const raw = parseYaml(file);
  const localFile = localConfigFile(file);
  const merged = fs.existsSync(localFile) ? deepMerge(raw, parseYaml(localFile) ?? {}) : raw;
  return { ...normalize(merged, file), localConfigFile: fs.existsSync(localFile) ? localFile : null };
}

/** Personal overrides next to lanes.yml (lanes.local.yml), merged on top and never shared. */
export const localConfigFile = (file) => path.join(path.dirname(file), 'lanes.local.yml');

function parseYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${file} is not valid YAML: ${e.message}`);
  }
}

/** Routed services, in config order. */
export const routedServices = (p) => Object.values(p.services).filter((s) => s.route);
export const entryServices = (p) => routedServices(p).filter((s) => s.entry);

export function resolveServiceName(p, name) {
  const n = String(name).trim().toLowerCase();
  if (p.services[n]) return n;
  const matches = Object.keys(p.services).filter((s) => s.endsWith(`-${n}`) || s.startsWith(`${n}-`));
  if (matches.length === 1) return matches[0];
  throw new UsageError(`Unknown service "${name}". Services: ${Object.keys(p.services).join(', ')}`);
}
