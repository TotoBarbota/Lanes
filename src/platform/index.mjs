// Everything that differs between operating systems lives here. The rest of the code must not
// branch on process.platform or call OS-specific tools directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';

const canonicalCache = new Map();

/** The real path of an existing file or folder (expands Windows 8.3 short names and symlinks). */
function canonical(p) {
  if (canonicalCache.has(p)) return canonicalCache.get(p);
  try {
    const real = fs.realpathSync.native(p);
    canonicalCache.set(p, real);
    return real;
  } catch {
    return p;
  }
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const eq = (x, y) => (isWindows ? x.toLowerCase() === y.toLowerCase() : x === y);
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return eq(na, nb) || eq(canonical(na), canonical(nb));
}

export function homeDir() {
  return os.homedir();
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Stops a process and everything it started. Processes started with startDetached() lead their
 * own process group on POSIX, so the whole group is signalled.
 */
export function killTree(pid) {
  if (!pidAlive(pid)) return false;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return true;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Copies a large directory tree (such as node_modules) as fast as the OS allows. `skip` lists
 * top-level entry names to leave out. Node's own fs.cpSync is several times slower on big trees.
 */
export function copyTree(src, dst, { skip = [] } = {}) {
  if (isWindows) {
    const args = [src, dst, '/E', '/MT:32', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'];
    if (skip.length) args.push('/XD', ...skip.map((s) => path.join(src, s)));
    // robocopy exit codes below 8 mean success.
    const r = spawnSync('robocopy', args, { windowsHide: true, stdio: 'ignore' });
    if (r.status === null || r.status >= 8) throw new Error(`robocopy failed (exit ${r.status}) copying ${src}`);
    return;
  }
  const clone = process.platform === 'darwin' ? ['-c'] : ['--reflink=auto'];
  let r = spawnSync('cp', ['-a', ...clone, src, dst], { stdio: 'ignore' });
  if (r.status !== 0) r = spawnSync('cp', ['-a', src, dst], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`cp failed (exit ${r.status}) copying ${src}`);
  for (const s of skip) fs.rmSync(path.join(dst, s), { recursive: true, force: true });
}

/** Docker Engine address when neither DOCKER_HOST nor a Docker context names one. */
export function defaultDockerHost() {
  return isWindows ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
}

/** Converts a path for use inside a git config value or a shell script (forward slashes everywhere). */
export function toPortablePath(p) {
  return p.replace(/\\/g, '/');
}
