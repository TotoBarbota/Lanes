import os from 'node:os';
import { runAsync, lines } from '../core/exec.mjs';
import { apiGet } from './api.mjs';

const GB = 1024 ** 3;

const healthOf = (status) => (/\(healthy\)/.test(status) ? 'healthy'
  : /\(unhealthy\)/.test(status) ? 'unhealthy'
    : /\(health: starting\)/.test(status) ? 'starting' : null);

function shape({ name, state, status, labels }) {
  return {
    name,
    state,
    status,
    health: healthOf(status),
    labels,
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
  };
}

function parseCliLabels(s) {
  const out = {};
  for (const part of String(s || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** All containers (running or not) with parsed labels. */
export async function listContainersAsync() {
  const api = await apiGet('/containers/json?all=1');
  if (Array.isArray(api)) {
    return api.map((c) => shape({ name: (c.Names?.[0] || '').replace(/^\//, ''), state: c.State, status: c.Status || '', labels: c.Labels || {} }));
  }
  const r = await runAsync('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { allowFail: true });
  if (!r.ok) return [];
  return lines(r.stdout).map((l) => {
    const c = JSON.parse(l);
    return shape({ name: c.Names, state: c.State, status: c.Status || '', labels: parseCliLabels(c.Labels) });
  });
}

function toBytes(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: GB, TB: 1e12, TIB: 1024 ** 4 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

// Same figure `docker stats` shows: usage minus reclaimable page cache.
function usedBytes(ms) {
  const cache = ms?.stats?.inactive_file ?? ms?.stats?.total_inactive_file ?? 0;
  return Math.max(0, (ms?.usage ?? 0) - cache);
}

/** Memory in use per running container, by name. */
export async function containerMemoryAsync(containers) {
  const list = containers ?? await listContainersAsync();
  const running = list.filter((c) => c.state === 'running');
  const results = await Promise.all(running.map((c) => apiGet(`/containers/${encodeURIComponent(c.name)}/stats?stream=false&one-shot=true`)));
  if (results.every((r) => r && r.memory_stats)) {
    return Object.fromEntries(running.map((c, i) => [c.name, { bytes: usedBytes(results[i].memory_stats) }]));
  }
  const r = await runAsync('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}'], { allowFail: true });
  const out = {};
  if (!r.ok) return out;
  for (const l of lines(r.stdout)) {
    const [name, usage] = l.split('\t');
    out[name] = { bytes: toBytes((usage || '').split('/')[0]) };
  }
  return out;
}

export async function dockerMemTotalAsync() {
  const info = await apiGet('/info');
  if (info?.MemTotal) return info.MemTotal;
  const r = await runAsync('docker', ['info', '--format', '{{.MemTotal}}'], { allowFail: true });
  return r.ok ? Number(r.stdout.trim()) || 0 : 0;
}

export function memorySnapshotFrom(perContainer, dockerTotal) {
  const dockerUsed = Object.values(perContainer).reduce((a, c) => a + c.bytes, 0);
  return {
    hostTotalGb: +(os.totalmem() / GB).toFixed(1),
    hostFreeGb: +(os.freemem() / GB).toFixed(1),
    dockerUsedGb: +(dockerUsed / GB).toFixed(1),
    dockerTotalGb: +(dockerTotal / GB).toFixed(1),
    dockerPercent: dockerTotal ? Math.round((dockerUsed / dockerTotal) * 100) : null,
  };
}

export async function memorySnapshot() {
  const [mem, total] = await Promise.all([containerMemoryAsync(), dockerMemTotalAsync()]);
  return memorySnapshotFrom(mem, total);
}

/** { exists, status, health, exitCode } for one container. */
export async function containerHealth(name) {
  const api = await apiGet(`/containers/${encodeURIComponent(name)}/json`);
  if (api?.notFound) return { exists: false };
  if (api?.State) return { exists: true, status: api.State.Status, health: api.State.Health?.Status || null, exitCode: api.State.ExitCode ?? null };
  const r = await runAsync('docker', ['inspect', '-f', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.ExitCode}}', name], { allowFail: true });
  if (!r.ok) return { exists: false };
  const [status, health, code] = r.stdout.trim().split('|');
  return { exists: true, status, health: health || null, exitCode: code === undefined ? null : Number(code) };
}

export async function imageExists(name) {
  const api = await apiGet(`/images/${encodeURIComponent(name)}/json`);
  if (api?.notFound) return false;
  if (api?.Id) return true;
  return (await runAsync('docker', ['image', 'inspect', '-f', '{{.Id}}', name], { allowFail: true })).ok;
}
