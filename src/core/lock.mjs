import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util.mjs';
import { sleep } from './exec.mjs';
import { pidAlive } from '../platform/index.mjs';

/**
 * Cross-process mutex based on exclusive file creation, so parallel agents never race on lane
 * numbers, builds or the router config. Stale locks (dead pid, or unreadable and older than 30s)
 * are broken automatically.
 */
export async function withLock(dir, name, fn, { timeoutMs = 20 * 60 * 1000, quiet = false } = {}) {
  ensureDir(dir);
  const file = path.join(dir, `${name}.lock`);
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
        if (age > 30_000) fs.rmSync(file, { force: true });
      }
      if (holder && !pidAlive(holder.pid)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for the "${name}" lock (${file}).`);
      if (!announced && !quiet) {
        console.log(`Waiting for the "${name}" lock held by pid ${holder?.pid ?? '?'}...`);
        announced = true;
      }
      await sleep(750);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}
