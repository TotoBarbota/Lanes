// Minimal Docker Engine API client. Talking to the engine directly avoids starting a docker CLI
// process per query, and `docker info` in particular can take seconds where the API takes
// milliseconds. Callers fall back to the CLI when this returns null.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { homeDir, defaultDockerHost } from '../platform/index.mjs';

let cached;

function contextHost(name) {
  const dir = process.env.DOCKER_CONFIG || path.join(homeDir(), '.docker');
  const meta = path.join(dir, 'contexts', 'meta', crypto.createHash('sha256').update(name).digest('hex'), 'meta.json');
  try {
    return JSON.parse(fs.readFileSync(meta, 'utf8')).Endpoints?.docker?.Host ?? null;
  } catch {
    return null;
  }
}

function currentContext() {
  if (process.env.DOCKER_CONTEXT) return process.env.DOCKER_CONTEXT;
  const dir = process.env.DOCKER_CONFIG || path.join(homeDir(), '.docker');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).currentContext || 'default';
  } catch {
    return 'default';
  }
}

/** Where the engine listens, resolved like the docker CLI does: DOCKER_HOST, current context, default. */
export function dockerEndpoint() {
  if (cached !== undefined) return cached;
  let host = process.env.DOCKER_HOST || null;
  if (!host) {
    const ctx = currentContext();
    host = ctx === 'default' ? null : contextHost(ctx);
  }
  host ||= defaultDockerHost();
  if (process.env.DOCKER_TLS_VERIFY) cached = null;
  else if (host.startsWith('npipe://')) cached = { socketPath: host.slice('npipe://'.length).replace(/\//g, '\\') };
  else if (host.startsWith('unix://')) cached = { socketPath: host.slice('unix://'.length) };
  else if (host.startsWith('tcp://')) {
    const u = new URL(host.replace('tcp://', 'http://'));
    cached = { host: u.hostname, port: Number(u.port) || 2375 };
  } else cached = null;
  return cached;
}

/** GET a Docker Engine API path. Resolves to parsed JSON, or null if the engine can't be reached. */
export function apiGet(urlPath, { timeoutMs = 5000 } = {}) {
  const ep = dockerEndpoint();
  if (!ep) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request({ ...ep, path: urlPath, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 404) return resolve({ notFound: true });
        if (res.statusCode >= 400) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
