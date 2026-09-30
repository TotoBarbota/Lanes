import { readJson, writeJson } from '../core/util.mjs';
import { withLock } from '../core/lock.mjs';
import { samePath } from '../platform/index.mjs';

export function loadRegistry(p) {
  const reg = readJson(p.paths.registry, null) || {};
  reg.lanes ||= {};
  reg.baselineUi ||= {};
  return reg;
}

export function saveRegistry(p, reg) {
  writeJson(p.paths.registry, reg);
}

/** Read-modify-write of the registry under the cross-process lock. */
export function updateRegistry(p, fn) {
  return withLock(p.paths.state, 'registry', async () => {
    const reg = loadRegistry(p);
    const result = await fn(reg);
    saveRegistry(p, reg);
    return result;
  });
}

export function freeLaneNumber(p, reg) {
  const used = new Set(Object.values(reg.lanes).map((l) => l.number));
  for (let n = 1; n <= p.lanes.max; n++) if (!used.has(n)) return n;
  return null;
}

export const laneForWorktree = (reg, top) => Object.values(reg.lanes).find((l) => samePath(l.worktree, top)) || null;
