import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAsync } from '../core/exec.mjs';
import { apiGet, dockerEndpoint } from '../docker/api.mjs';
import { UsageError, readJson, writeJson, ensureDir } from '../core/util.mjs';
import { pidAlive, killTree } from '../platform/index.mjs';
import { linkConfig, routedServices } from '../config/load.mjs';
import { lanePorts } from '../project/ports.mjs';
import { portOpen } from '../ui/devserver.mjs';
import { worktreeInfo } from '../git/repo.mjs';
import {
  prepareWorktree, teardownWorktree, protectionStatus, installHooks, uninstallHooks, hooksStatus, runPreCommit, writeLocalAgentFiles,
} from '../git/protect.mjs';
import { writeRouterConf, reloadRouter, routerRunning } from '../router/nginx.mjs';
import { agentJar, usesJava } from '../runtimes/java.mjs';
import { memorySnapshot } from '../docker/containers.mjs';
import { loadRegistry } from '../state/registry.mjs';
import { LANES_BIN, PACKAGE_ROOT } from '../agents/instructions.mjs';
import { log, currentWorktree } from '../cli/context.mjs';

export async function cmdSetup(p, pos, opts) {
  const dir = opts.path ? path.resolve(opts.path) : currentWorktree(p, opts).top;
  const action = pos[0] || 'status';
  if (action === 'on') {
    const r = prepareWorktree(p, dir);
    log(`Setup applied in ${dir}. Protected files hidden: ${r.protect.marked}/${r.protect.total}. Local agent files written: ${r.agentFiles}.`);
  } else if (action === 'off') {
    const r = teardownWorktree(p, dir);
    log(`Setup undone in ${dir}. Protected files un-hidden: ${r.cleared}.`);
  } else {
    const s = protectionStatus(p, dir);
    log(`${dir}: ${s.marked} protected files hidden from git status${s.exposed.length ? `; ${s.exposed.length} edited but still visible: ${s.exposed.join(', ')} (run: lanes setup on)` : '; none exposed'}.`);
  }
}

export async function cmdHooks(p, pos) {
  const action = pos[0] || 'status';
  if (action === 'run') {
    if (pos[1] !== 'pre-commit') return;
    process.exitCode = runPreCommit(p, worktreeInfo(process.cwd()).top);
    return;
  }
  if (action === 'install') {
    const r = installHooks(p, LANES_BIN);
    writeLocalAgentFiles(p, p.repo);
    log(`core.hooksPath -> ${p.paths.hooks} (local .git/config only; covers the main checkout and every worktree).`);
    if (r.previous) log(`Existing hooks in ${r.previous} still run after the lanes check.`);
    return;
  }
  if (action === 'uninstall') {
    const r = uninstallHooks(p);
    log(r.restored ? `lanes hooks removed; core.hooksPath ${r.previous ? `restored to ${r.previous}` : 'unset'}.` : 'lanes hooks were not active.');
    return;
  }
  const s = hooksStatus(p);
  log(`core.hooksPath = ${s.current || '(unset)'} ${s.active ? '(lanes hooks active)' : '(lanes hooks NOT active)'}${s.previous ? `; chains to ${s.previous}` : ''}`);
}

export async function cmdRouter(p) {
  writeRouterConf(p, loadRegistry(p));
  const r = await reloadRouter(p);
  log(r.reloaded ? 'Router config regenerated and reloaded.' : `Router config regenerated (${r.reason}).`);
}

export async function cmdLink(p0, pos) {
  if (!pos[0]) throw new UsageError('Usage: lanes link <path-to-lanes.yml>   (run inside the repository)');
  const repo = linkConfig(process.cwd(), pos[0]);
  log(`Linked ${repo.mainCheckout || repo.top} to ${path.resolve(pos[0])}. Every worktree of this repo now uses it.`);
}

export async function cmdDashboard(p, pos) {
  const pidFile = path.join(p.paths.state, 'dashboard.pid');
  const cur = Number(readJson(pidFile, {}).pid);
  if (pos[0] === 'stop') {
    if (killTree(cur)) log('Dashboard stopped.');
    fs.rmSync(pidFile, { force: true });
    return;
  }
  if (pidAlive(cur)) {
    log(`Dashboard already running: http://localhost:${p.dashboard.port}`);
    return;
  }
  ensureDir(p.paths.logs);
  const out = fs.openSync(path.join(p.paths.logs, 'dashboard.log'), 'a');
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'dashboard', 'server.mjs'), '--config', p.configFile], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  writeJson(pidFile, { pid: child.pid });
  log(`Dashboard: http://localhost:${p.dashboard.port}  (pid ${child.pid})`);
}

/**
 * Ports lanes needs that something else holds. Ports held by the project's own compose
 * containers don't count: "baseline up" recreates those without host ports.
 */
async function portConflicts(p, { router }) {
  const reg = loadRegistry(p);
  const wanted = new Map();
  if (!router) for (const s of routedServices(p)) wanted.set(s.port, `${s.name} (router)`);
  for (const u of Object.values(p.uis)) if (!pidAlive(reg.baselineUi?.[u.key]?.pid)) wanted.set(u.port, `${u.label} UI`);
  if (!pidAlive(Number(readJson(path.join(p.paths.state, 'dashboard.pid'), {}).pid))) wanted.set(p.dashboard.port, 'dashboard');
  const used = new Set(Object.values(reg.lanes).map((l) => l.number));
  for (let n = 1; n <= p.lanes.max; n++) {
    if (used.has(n)) continue;
    const ports = lanePorts(p, n);
    for (const [svc, port] of Object.entries(ports.entry)) wanted.set(port, `lane #${n} ${svc} entry`);
    for (const [key, port] of Object.entries(ports.ui)) wanted.set(port, `lane #${n} ${p.uis[key].label} UI`);
  }
  const containers = (await apiGet('/containers/json')) || [];
  const holder = new Map();
  for (const c of Array.isArray(containers) ? containers : []) {
    for (const pt of c.Ports || []) {
      if (pt.PublicPort) holder.set(pt.PublicPort, { name: (c.Names?.[0] || '').replace(/^\//, ''), project: c.Labels?.['com.docker.compose.project'] });
    }
  }
  const out = [];
  const open = await Promise.all([...wanted.keys()].map((port) => portOpen(port)));
  [...wanted].forEach(([port, what], i) => {
    if (!open[i]) return;
    const h = holder.get(port);
    if (h && h.project === p.compose.project) return;
    out.push(`:${port} for ${what} is in use by ${h ? `container ${h.name}` : 'another program'}`);
  });
  return out;
}

export async function cmdDoctor(p) {
  let bad = 0;
  // ok: true = fine, false = broken, 'todo' = not set up yet, with the command that does it.
  const check = (label, ok, extra = '') => {
    if (ok === false) bad++;
    const tag = ok === 'todo' ? 'TODO' : ok ? 'OK  ' : 'FAIL';
    log(`${tag}  ${label}${extra ? ` - ${extra}` : ''}`);
  };
  log(`Project ${p.name}: ${p.configFile}${p.localConfigFile ? ` + ${path.basename(p.localConfigFile)}` : ''}`);
  const [engine, compose] = await Promise.all([
    apiGet('/version'),
    runAsync('docker', ['compose', 'version', '--short'], { allowFail: true }),
  ]);
  check('docker engine', !!engine?.Version, engine?.Version ? `${engine.Version} (API ${dockerEndpoint()?.socketPath || 'tcp'})` : 'not reachable (is Docker running?)');
  check('docker compose v2', compose.ok, compose.stdout.trim());
  check('repository', fs.existsSync(path.join(p.repo, '.git')), p.repo);
  if (usesJava(p)) {
    const have = fs.existsSync(agentJar(p));
    check('OpenTelemetry Java agent', have || 'todo', have ? agentJar(p) : 'downloaded by the first "lanes baseline up"');
  }
  const bw = p.paths.baselineWorktree;
  const haveBw = fs.existsSync(path.join(bw, '.git'));
  check('baseline worktree', haveBw || 'todo', haveBw ? bw : 'created by "lanes baseline up"');
  if (p.worktree.protect.length && haveBw) {
    const s = protectionStatus(p, bw);
    check('baseline protected files hidden', !s.exposed.length, s.exposed.length ? `exposed: ${s.exposed.join(', ')}` : `${s.marked} hidden`);
  }
  if (p.worktree.protect.length || p.agents.localFiles.length) {
    const h = hooksStatus(p);
    check('commit guard hook', h.active || 'todo', h.active ? p.paths.hooks : 'run: lanes hooks install');
  }
  const router = await routerRunning(p);
  check('router', router || 'todo', router ? 'running' : 'down (run: lanes baseline up)');
  const conflicts = await portConflicts(p, { router });
  check('ports', !conflicts.length, conflicts.length ? conflicts.join('; ') : 'baseline, lane and dashboard ports are free or already owned by lanes');
  for (const l of Object.values(loadRegistry(p).lanes)) check(`lane ${l.name} worktree exists`, fs.existsSync(l.worktree), l.worktree);
  const m = await memorySnapshot();
  check('memory headroom', m.hostFreeGb >= p.memory.minHostFreeGb, `host free ${m.hostFreeGb} GB, docker ${m.dockerUsedGb}/${m.dockerTotalGb} GB`);
  if (bad) process.exitCode = 1;
}
