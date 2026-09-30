import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const baseEnv = (env) => (env ? { ...process.env, ...env } : process.env);

// LANES_TIMING=1 prints every external command with its duration to stderr.
const TIMING = !!process.env.LANES_TIMING;
const T0 = Date.now();
function timed(label, fn) {
  if (!TIMING) return fn();
  const t = Date.now();
  const done = () => process.stderr.write(`[timing +${((Date.now() - T0) / 1000).toFixed(2)}s] ${((Date.now() - t) / 1000).toFixed(2)}s ${label}\n`);
  const r = fn();
  if (r && typeof r.then === 'function') return r.finally(done);
  done();
  return r;
}
const label = (cmd, args) => `${cmd} ${args.join(' ')}`.slice(0, 140);
if (TIMING) {
  const mark = (what) => process.stderr.write(`[timing +${((Date.now() - T0) / 1000).toFixed(2)}s] ${what}\n`);
  process.once('beforeExit', () => mark('work done'));
  process.once('exit', () => mark('exit'));
}

/** Runs a command and captures output. Throws on non-zero exit unless allowFail. */
export function run(cmd, args, opts = {}) {
  return timed(label(cmd, args), () => runSync(cmd, args, opts));
}

function runSync(cmd, args, { cwd, allowFail = false, input, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    env: baseEnv(env),
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    if (allowFail) return { ok: false, stdout: '', stderr: String(r.error.message), code: -1 };
    throw r.error;
  }
  const res = { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
  if (!res.ok && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}):\n${(res.stderr || res.stdout).trim()}`);
  }
  return res;
}

/** Same contract as run(), but does not block the event loop. The dashboard server depends on this. */
export function runAsync(cmd, args, opts = {}) {
  return timed(`async ${label(cmd, args)}`, () => runAsyncRaw(cmd, args, opts));
}

function runAsyncRaw(cmd, args, { cwd, allowFail = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: baseEnv(env), windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => {
      if (allowFail) resolve({ ok: false, stdout: '', stderr: String(e.message), code: -1 });
      else reject(e);
    });
    child.on('close', (code) => {
      const res = { ok: code === 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code };
      if (!res.ok && !allowFail) reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code}):\n${(res.stderr || res.stdout).trim()}`));
      else resolve(res);
    });
  });
}

/** Runs a command with inherited stdio. Returns the exit code. */
export function runInherit(cmd, args, { cwd, env } = {}) {
  return timed(`inherit ${label(cmd, args)}`, () => {
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: baseEnv(env), windowsHide: true });
    if (r.error) throw r.error;
    return r.status ?? 1;
  });
}

/**
 * Runs a command with stdin and/or stdout connected to files, streaming (no size limit).
 * Returns { code, stderr }.
 */
export function runWithFiles(cmd, args, { stdinFile, stdoutFile } = {}) {
  return timed(`files ${label(cmd, args)}`, () => {
    const inFd = stdinFile ? fs.openSync(stdinFile, 'r') : 'ignore';
    const outFd = stdoutFile ? fs.openSync(stdoutFile, 'w') : 'inherit';
    try {
      const r = spawnSync(cmd, args, { stdio: [inFd, outFd, 'pipe'], encoding: 'utf8', windowsHide: true });
      if (r.error) throw r.error;
      return { code: r.status ?? 1, stderr: r.stderr ?? '' };
    } finally {
      if (typeof inFd === 'number') fs.closeSync(inFd);
      if (typeof outFd === 'number') fs.closeSync(outFd);
    }
  });
}

/** Runs a shell command line (cmd.exe on Windows, /bin/sh elsewhere) with inherited stdio. */
export function runShell(command, { cwd, env } = {}) {
  const r = spawnSync(command, { cwd, stdio: 'inherit', env: baseEnv(env), shell: true, windowsHide: true });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/**
 * Starts a shell command line in the background, detached from this process, with output going to
 * logFile. On POSIX the child leads its own process group, so killTree() stops all of it.
 */
export function startDetached(command, { cwd, env, logFile }) {
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(command, { cwd, env: baseEnv(env), shell: true, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

export const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
