import fs from 'node:fs';
import { run, runInherit } from '../core/exec.mjs';
import { UsageError, writeJson, readJson } from '../core/util.mjs';
import { pidAlive } from '../platform/index.mjs';
import { resolveServiceName, routedServices } from '../config/load.mjs';
import { worktreeInfo, ensureBaselineWorktree, fetchRefs } from '../git/repo.mjs';
import { prepareWorktree, teardownWorktree } from '../git/protect.mjs';
import { generateBaselineCompose, baselineContainerName } from '../stack/compose.mjs';
import { writeRouterConf, routerRunning, reloadRouter } from '../router/nginx.mjs';
import { ensureAgent, usesJava } from '../runtimes/java.mjs';
import { startDevServer, stopDevServer } from '../ui/devserver.mjs';
import { localUrl } from '../project/ports.mjs';
import { loadRegistry, updateRegistry } from '../state/registry.mjs';
import { collectState } from '../state/collect.mjs';
import { log, warn, composeArgs, waitForContainers } from '../cli/context.mjs';

async function up(p, opts) {
  if (ensureBaselineWorktree(p)) log(`Created baseline worktree at ${p.paths.baselineWorktree}`);
  prepareWorktree(p, p.paths.baselineWorktree);
  if (usesJava(p)) await ensureAgent(p, log);
  writeRouterConf(p, loadRegistry(p));
  const compose = generateBaselineCompose(p, { heavy: !!opts.heavy });
  const file = p.paths.baselineCompose;
  const services = Object.keys(compose.services).filter((s) => s !== 'lane-router');
  const upArgs = ['up', '-d', '--remove-orphans'];
  if (!opts.nobuild) upArgs.push('--build');
  if (runInherit('docker', composeArgs(p.compose.project, file, ...upArgs, ...services)) !== 0) throw new Error('docker compose up failed for the baseline');
  if (runInherit('docker', composeArgs(p.compose.project, file, 'up', '-d', 'lane-router')) !== 0) throw new Error('Could not start the lane router');
  // An already running router keeps its old config until reloaded.
  await reloadRouter(p, { onlyIfChanged: true });
  const wt = worktreeInfo(p.paths.baselineWorktree);
  writeJson(p.paths.baselineState, { ref: p.refs.baseline, head: wt.head, heavy: !!opts.heavy, startedAt: new Date().toISOString() });
  let problems = 0;
  if (!opts.nowait) {
    log('\nWaiting for baseline services to become healthy...');
    const byName = new Map(services.map((s) => [compose.services[s].container_name || `${p.compose.project}-${s}-1`, s]));
    const res = await waitForContainers([...byName.keys()], 10 * 60 * 1000, { oneShots: true });
    for (const f of res.failed) log(`  ${f.name} is ${f.status}${f.health ? ` (${f.health})` : ''}. Check: lanes logs ${byName.get(f.name)} --baseline`);
    for (const t of res.timedOut) log(`  ${t} is still starting.`);
    problems = res.failed.length + res.timedOut.length;
  }
  log(`\nBaseline is ${problems ? 'up with problems' : 'up'} in lanes mode (${p.refs.baseline} @ ${wt.head}). Router owns ports ${routedServices(p).map((s) => s.port).join(', ')}.`);
  if (problems) process.exitCode = 1;
}

async function ui(p, pos, opts) {
  const keys = pos[1] ? [pos[1]] : Object.keys(p.uis);
  await updateRegistry(p, (reg) => {
    for (const key of keys) {
      const def = p.uis[key];
      if (!def) throw new UsageError(`Unknown UI "${key}". UIs: ${Object.keys(p.uis).join(', ')}`);
      const cur = reg.baselineUi[key];
      if (opts.stop) {
        if (cur && stopDevServer(cur.pid)) log(`Stopped baseline ${def.label} UI (pid ${cur.pid}).`);
        delete reg.baselineUi[key];
        continue;
      }
      if (cur && pidAlive(cur.pid)) {
        log(`Baseline ${def.label} UI already running on :${cur.port} (pid ${cur.pid}).`);
        continue;
      }
      const vars = (k) => {
        if (k === 'port') return def.port;
        if (k === 'lane') return '';
        const [kind, name] = k.split(':');
        if (kind === 'entry' && p.services[name]) return localUrl(p.services[name].port);
        if (kind === 'ui' && p.uis[name]) return localUrl(p.uis[name].port);
        return undefined;
      };
      reg.baselineUi[key] = startDevServer(p, def, { checkout: p.paths.baselineWorktree, port: def.port, env: def.env, vars, logName: `baseline-${key}-ui` });
      log(`Started baseline ${def.label} UI on :${def.port} (pid ${reg.baselineUi[key].pid}), log ${reg.baselineUi[key].log}`);
    }
  });
}

export async function cmdBaseline(p, pos, opts) {
  const action = pos[0] || 'status';
  const file = p.paths.baselineCompose;
  if (action === 'up') return up(p, opts);
  if (action === 'down') {
    const active = Object.keys(loadRegistry(p).lanes);
    if (active.length && !opts.force) throw new UsageError(`Lanes still registered: ${active.join(', ')}. Close them first or add --force.`);
    if (!fs.existsSync(file)) throw new UsageError('No generated baseline compose file; nothing to stop.');
    process.exitCode = runInherit('docker', composeArgs(p.compose.project, file, 'down'));
    return undefined;
  }
  if (action === 'refresh') {
    const f = fetchRefs(p.repo, [p.refs.baseline]);
    if (!f.ok) warn(`git fetch failed (${f.message}). Using the last fetched ${p.refs.baseline}.`);
    ensureBaselineWorktree(p);
    teardownWorktree(p, p.paths.baselineWorktree);
    run('git', ['checkout', '--detach', p.refs.baseline], { cwd: p.paths.baselineWorktree });
    prepareWorktree(p, p.paths.baselineWorktree);
    log(`Baseline worktree now at ${p.refs.baseline} @ ${worktreeInfo(p.paths.baselineWorktree).head}.`);
    if (await routerRunning(p)) {
      log('Rebuilding the running baseline...');
      return up(p, { heavy: readJson(p.paths.baselineState, {}).heavy });
    }
    return undefined;
  }
  if (action === 'pause' || action === 'resume') {
    if (!pos[1]) throw new UsageError(`Usage: lanes baseline ${action} <service>`);
    process.exitCode = runInherit('docker', [action === 'pause' ? 'stop' : 'start', baselineContainerName(p, resolveServiceName(p, pos[1]))]);
    return undefined;
  }
  if (action === 'ui') return ui(p, pos, opts);
  if (action !== 'status') throw new UsageError('Usage: lanes baseline up [--heavy] [--no-build] | down [--force] | refresh | status | pause <svc> | resume <svc> | ui [key] [--stop]');
  const st = await collectState(p, { withMemory: false });
  log(`Baseline ${st.baseline.mode} mode; worktree ${p.paths.baselineWorktree}`);
  for (const c of st.baseline.containers) log(`  ${c.name.padEnd(48)} ${c.state}${c.health ? `/${c.health}` : ''}`);
  return undefined;
}
