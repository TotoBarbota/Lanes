#!/usr/bin/env node
// lanes dashboard: monitor for the baseline, the router, lanes and worktrees, with buttons to
// start, update and close lanes. Actions run the lanes CLI as background jobs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAsync } from '../src/core/exec.mjs';
import { samePath } from '../src/platform/index.mjs';
import { loadProject, routedServices } from '../src/config/load.mjs';
import { listWorktrees } from '../src/git/repo.mjs';
import { collectState } from '../src/state/collect.mjs';
import { portOpen } from '../src/ui/devserver.mjs';
import { parseArgs } from '../src/cli/args.mjs';
import { LANES_BIN } from '../src/agents/instructions.mjs';
import { ensureDir } from '../src/core/util.mjs';

const { opts } = parseArgs(process.argv.slice(2));
const p = loadProject({ configFile: opts.config });
const PORT = Number(opts.port) || p.dashboard.port;
const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'index.html');
const REFRESH_MS = 4000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const STREAM_HEARTBEAT_MS = 15000;

let snapshot = null;
let inFlight = null;

function refresh() {
  inFlight ||= doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh() {
  try {
    const uis = Object.values(p.uis);
    const [st, wtList, ...uiUp] = await Promise.all([collectState(p), listWorktrees(p.repo, runAsync), ...uis.map((u) => portOpen(u.port))]);
    snapshot = {
      ...st,
      worktrees: wtList.map((w) => ({
        ...w,
        lane: st.lanes.find((l) => samePath(l.worktree, w.path))?.name || null,
        isMain: samePath(w.path, p.repo),
        isBaseline: samePath(w.path, p.paths.baselineWorktree),
      })),
      baselinePorts: Object.fromEntries(uis.map((u, i) => [u.key, uiUp[i]])),
      error: null,
    };
  } catch (e) {
    snapshot = { ...(snapshot || {}), error: e.message, generatedAt: new Date().toISOString() };
  }
}

function knownContainers() {
  if (!snapshot) return new Set();
  const names = new Set();
  for (const c of snapshot.baseline?.containers || []) names.add(c.name);
  for (const l of snapshot.lanes || []) for (const s of l.services) names.add(s.container);
  for (const c of snapshot.orphans || []) names.add(c.name);
  if (snapshot.router) names.add(snapshot.router.name);
  return names;
}

function dockerLogs(container, tail) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['logs', '--tail', String(tail), '--timestamps', container], { windowsHide: true });
    const chunks = [];
    let size = 0;
    const take = (b) => {
      if (size < MAX_LOG_BYTES) chunks.push(b);
      size += b.length;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, text: Buffer.concat(chunks).toString('utf8') }));
    child.on('error', (e) => resolve({ code: -1, text: e.message }));
  });
}

/**
 * Server-sent events: the last `tail` lines, then new lines as the container writes them.
 * The stream ends when `docker logs --follow` exits (container stopped or recreated).
 */
function streamLogs(res, container, tail) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  let open = true;
  const sse = (event, data) => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Sent first on every (re)connect so the browser discards what it had and never shows the tail twice.
  sse('reset', { container, tail });

  const child = spawn('docker', ['logs', '--follow', '--tail', String(tail), '--timestamps', container], { windowsHide: true });
  const forward = (stream) => {
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (s) => {
      partial += s;
      const cut = partial.lastIndexOf('\n');
      if (cut < 0) return;
      sse('lines', partial.slice(0, cut));
      partial = partial.slice(cut + 1);
    });
    stream.on('end', () => {
      if (partial) sse('lines', partial);
    });
  };
  forward(child.stdout);
  forward(child.stderr);

  const ping = setInterval(() => open && res.write(': ping\n\n'), STREAM_HEARTBEAT_MS);
  const finish = (reason) => {
    if (!open) return;
    sse('end', reason);
    open = false;
    clearInterval(ping);
    res.end();
  };
  child.on('error', (e) => finish({ error: e.message }));
  child.on('close', (code) => finish({ code }));
  res.on('close', () => {
    open = false;
    clearInterval(ping);
    child.kill();
  });
}

function validContainer(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) && knownContainers().has(name);
}

// ---------------------------------------------------------------- lane actions (jobs)

const JOBS_DIR = path.join(p.paths.logs, 'jobs');
const KEEP_JOBS = 30;
const jobs = new Map();
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const publicJob = (j) => ({
  id: j.id, action: j.action, worktree: j.worktree, lane: j.lane, command: j.command,
  startedAt: j.startedAt, endedAt: j.endedAt, code: j.code, running: j.code === null,
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function worktreeOf(dir) {
  const w = (snapshot?.worktrees || []).find((x) => samePath(x.path, String(dir || '')));
  if (!w) throw new HttpError(400, `Unknown worktree: ${dir}`);
  if (w.isBaseline) throw new HttpError(400, 'The baseline worktree cannot run a lane.');
  return w;
}

/** CLI arguments for a request, built only from validated values. */
function jobArgs(body) {
  const routed = new Set(routedServices(p).map((s) => s.name));
  const list = (v, allowed, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => allowed.has(x))) throw new HttpError(400, `Invalid ${what}.`);
    return v;
  };
  if (body.action === 'down') {
    const lane = (snapshot?.lanes || []).find((l) => l.name === body.lane);
    if (!lane) throw new HttpError(400, `Unknown lane: ${body.lane}`);
    return { worktree: lane.worktree, lane: lane.name, args: ['down', '--name', lane.name, '--force'] };
  }
  const w = worktreeOf(body.worktree);
  if (body.action === 'detect') return { worktree: w.path, lane: w.lane, args: ['detect', '--path', w.path] };
  if (body.action !== 'up') throw new HttpError(400, 'action must be up, down or detect');
  const args = ['up', '--path', w.path];
  const name = body.name ?? w.lane;
  if (name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new HttpError(400, 'Invalid lane name.');
    args.push('--name', name);
  }
  const include = list(body.include, routed, 'services');
  if (include.length) args.push('--include', include.join(','));
  if (body.ui === 'none') args.push('--no-ui');
  else if (body.ui !== undefined && body.ui !== 'auto') {
    const uis = list(body.ui, new Set(Object.keys(p.uis)), 'UIs');
    if (uis.length) args.push('--ui', uis.join(','));
  }
  if (body.jobs === true) args.push('--jobs');
  if (body.rebuild === true) args.push('--rebuild');
  return { worktree: w.path, lane: name || null, args };
}

function startJob(body) {
  const { worktree, lane, args } = jobArgs(body);
  const busy = [...jobs.values()].find((j) => j.code === null && (samePath(j.worktree, worktree) || (lane && j.lane === lane)));
  if (busy) throw new HttpError(409, `"lanes ${busy.action}" is still running for ${busy.lane || busy.worktree}.`);
  ensureDir(JOBS_DIR);
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const logFile = path.join(JOBS_DIR, `${id}.log`);
  const command = `lanes ${args.join(' ')}`;
  fs.writeFileSync(logFile, `$ ${command}\n`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [LANES_BIN, ...args, '--config', p.configFile], {
    cwd: fs.existsSync(worktree) ? worktree : p.repo,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', BUILDKIT_PROGRESS: 'plain' },
  });
  fs.closeSync(out);
  const job = { id, action: args[0], worktree, lane, command, logFile, startedAt: new Date().toISOString(), endedAt: null, code: null };
  jobs.set(id, job);
  const done = (code) => {
    if (job.code !== null) return;
    job.code = code ?? 1;
    job.endedAt = new Date().toISOString();
    fs.appendFileSync(logFile, `\n[exit ${job.code}]\n`);
    refresh();
  };
  child.on('exit', done);
  child.on('error', (e) => {
    fs.appendFileSync(logFile, `${e.message}\n`);
    done(1);
  });
  for (const old of [...jobs.values()].filter((j) => j.code !== null).slice(0, Math.max(0, jobs.size - KEEP_JOBS))) jobs.delete(old.id);
  return job;
}

/** Server-sent events for a job's output file: everything so far, then new output until it exits. */
function streamJob(res, job) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  let open = true;
  let pos = 0;
  let partial = '';
  const sse = (event, data) => open && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  sse('reset', { job: job.id });
  const pump = () => {
    const size = fs.existsSync(job.logFile) ? fs.statSync(job.logFile).size : 0;
    if (size > pos) {
      const fd = fs.openSync(job.logFile, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = size;
      partial += buf.toString('utf8').replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
      const cut = partial.lastIndexOf('\n');
      if (cut >= 0) {
        sse('lines', partial.slice(0, cut));
        partial = partial.slice(cut + 1);
      }
    }
    if (job.code !== null && pos >= size) {
      if (partial) sse('lines', partial);
      sse('end', { code: job.code });
      stop();
    }
  };
  const timer = setInterval(pump, 400);
  const stop = () => {
    if (!open) return;
    open = false;
    clearInterval(timer);
    res.end();
  };
  res.on('close', stop);
  pump();
}

// ---------------------------------------------------------------- http

// Only this dashboard's own page may trigger actions: a token embedded in the page, plus Host and
// Origin checks (other websites and DNS-rebinding pages can't read the token or pass the checks).
const TOKEN = crypto.randomBytes(24).toString('hex');
const LOCAL = new RegExp(`^(localhost|127\\.0\\.0\\.1|\\[::1\\]):${PORT}$`);
const localHost = (req) => LOCAL.test(req.headers.host || '');
const sameOrigin = (req) => !req.headers.origin || LOCAL.test(req.headers.origin.replace(/^http:\/\//, ''));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) reject(new HttpError(413, 'Request too large.'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Body must be JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function handlePost(req, res, url) {
  if (url.pathname !== '/api/jobs') return send(res, 404, { error: 'not found' });
  if (!sameOrigin(req) || req.headers['x-lanes-token'] !== TOKEN) return send(res, 403, { error: 'Actions are only accepted from the dashboard page. Reload it.' });
  if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON.' });
  try {
    const body = await readBody(req);
    if (!snapshot) await refresh();
    return send(res, 202, publicJob(startJob(body)));
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (!localHost(req)) return send(res, 421, { error: `Open the dashboard as http://localhost:${PORT}` });
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST') return handlePost(req, res, url);
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(INDEX, 'utf8').replace('</head>', `<meta name="lanes-token" content="${TOKEN}">\n</head>`);
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/api/state') {
    if (!snapshot) await refresh();
    return send(res, 200, { ...snapshot, jobs: [...jobs.values()].map(publicJob) });
  }
  if (url.pathname === '/api/jobs/stream') {
    const job = jobs.get(url.searchParams.get('id') || '');
    if (!job) return send(res, 404, { error: 'unknown job' });
    return streamJob(res, job);
  }
  if (url.pathname === '/api/logs' || url.pathname === '/api/logs/stream') {
    const container = url.searchParams.get('container') || '';
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 300, 20), 5000);
    if (!snapshot) await refresh();
    if (!validContainer(container)) return send(res, 404, { error: `unknown container: ${container}` });
    if (url.pathname === '/api/logs/stream') return streamLogs(res, container, tail);
    const r = await dockerLogs(container, tail);
    return send(res, 200, { container, tail, code: r.code, text: r.text });
  }
  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`lanes dashboard for ${p.name} on http://localhost:${PORT}`);
  setTimeout(refresh, 0);
  setInterval(refresh, REFRESH_MS);
});
