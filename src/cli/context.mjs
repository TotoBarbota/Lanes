import { run, runInherit, sleep } from '../core/exec.mjs';
import { UsageError, sanitizeLaneName, parseSizeMb } from '../core/util.mjs';
import { samePath } from '../platform/index.mjs';
import { worktreeInfo, assertProjectWorktree } from '../git/repo.mjs';
import { laneForWorktree } from '../state/registry.mjs';
import { memorySnapshot, containerHealth } from '../docker/containers.mjs';
import { portOpen } from '../ui/devserver.mjs';

export const log = (...a) => console.log(...a);
export const warn = (msg) => console.log(`WARNING: ${msg}`);

export function currentWorktree(p, opts) {
  const wt = worktreeInfo(opts.path || process.cwd());
  assertProjectWorktree(wt, p);
  return wt;
}

export function resolveLane(p, reg, opts) {
  if (opts.name) {
    const lane = reg.lanes[sanitizeLaneName(opts.name)];
    if (!lane) throw new UsageError(`No lane named "${opts.name}".`);
    return lane;
  }
  const wt = currentWorktree(p, opts);
  const lane = laneForWorktree(reg, wt.top);
  if (!lane) throw new UsageError(`No lane is registered for ${wt.top}. Run "lanes up" first, or pass --name.`);
  return lane;
}

/** Agents may only act on the lane of the worktree they run in. --force is for the user. */
export function assertOwnLane(p, lane, opts) {
  if (opts.force) return;
  let wt = null;
  try {
    wt = currentWorktree(p, opts);
  } catch {
    wt = null;
  }
  if (!wt || !samePath(wt.top, lane.worktree)) {
    throw new UsageError(`Lane "${lane.name}" belongs to ${lane.worktree}. Run this from that worktree (agents: never touch another lane; users: add --force).`);
  }
}

export function composeArgs(project, file, ...rest) {
  return ['compose', '-p', project, '-f', file, ...rest];
}

export async function memoryGuard(p, { javaServices, uiKeys }) {
  const snap = await memorySnapshot();
  const javaNeed = javaServices.reduce((a, s) => a + (parseSizeMb(p.services[s].heap.lane) + p.runtimes.java.memOverheadMb) / 1024, 0);
  const uiNeed = uiKeys.reduce((a, k) => a + p.uis[k].memoryGb, 0);
  const problems = [];
  const hostAfter = snap.hostFreeGb - javaNeed - uiNeed;
  if (hostAfter < p.memory.minHostFreeGb) {
    problems.push(`host free memory would drop to ~${hostAfter.toFixed(1)} GB (now ${snap.hostFreeGb} GB, need ~${(javaNeed + uiNeed).toFixed(1)} GB, floor ${p.memory.minHostFreeGb} GB)`);
  }
  if (snap.dockerTotalGb) {
    const pct = ((snap.dockerUsedGb + javaNeed) / snap.dockerTotalGb) * 100;
    if (pct > p.memory.maxDockerPercent) problems.push(`Docker memory would reach ~${Math.round(pct)}% of its ${snap.dockerTotalGb} GB cap (limit ${p.memory.maxDockerPercent}%)`);
  }
  return { snap, problems };
}

/** Waits until each container is healthy or running without a healthcheck; with oneShots, exited 0 also counts. */
export async function waitForContainers(names, timeoutMs, { oneShots = false } = {}) {
  const started = Date.now();
  const pending = new Set(names);
  const failed = [];
  while (pending.size && Date.now() - started < timeoutMs) {
    for (const n of [...pending]) {
      const h = await containerHealth(n);
      if (!h.exists) continue;
      if (oneShots && h.status === 'exited' && h.exitCode === 0) {
        pending.delete(n);
        log(`  done: ${n}`);
      } else if (h.status === 'exited' || h.status === 'dead' || h.health === 'unhealthy') {
        failed.push({ name: n, ...h });
        pending.delete(n);
      } else if (h.status === 'running' && (h.health === 'healthy' || h.health === null)) {
        pending.delete(n);
        log(`  ready: ${n}`);
      }
    }
    if (pending.size) await sleep(2000);
  }
  return { failed, timedOut: [...pending] };
}

export async function waitForPorts(ports, timeoutMs) {
  const started = Date.now();
  const pending = new Set(ports);
  while (pending.size && Date.now() - started < timeoutMs) {
    for (const port of [...pending]) if (await portOpen(port)) pending.delete(port);
    if (pending.size) await sleep(2000);
  }
  return [...pending];
}

export function dockerLogsTail(container, lines = 60) {
  return runInherit('docker', ['logs', '--tail', String(lines), container]);
}

export function containerExists(name) {
  return run('docker', ['inspect', '-f', '{{.Name}}', name], { allowFail: true }).ok;
}
