import path from 'node:path';
import { run } from '../core/exec.mjs';
import { UsageError, writeJson, readJson, deepMerge } from '../core/util.mjs';
import { routedServices } from '../config/load.mjs';
import { lanePorts, routerPorts, localUrl } from '../project/ports.mjs';
import { attachAgent, mergeSpringJson, memLimit, heapFlags, debugFlags, springUrlDefaults } from '../runtimes/java.mjs';

/** DNS name of the router on the stack's networks. Every service-to-service URL is pointed at it. */
export const ROUTER_HOST = 'lane-router';

export const LABELS = {
  role: 'lanes.role',
  project: 'lanes.project',
  service: 'lanes.service',
  lane: 'lanes.lane',
  worktree: 'lanes.worktree',
};

export const routerContainer = (p) => `${p.name}-lane-router`;

/** Container name of a baseline service, from the generated compose file (compose's default otherwise). */
export function baselineContainerName(p, svc) {
  return readJson(p.paths.baselineCompose, null)?.services?.[svc]?.container_name || `${p.compose.project}-${svc}-1`;
}
export const laneProject = (p, lane) => `${p.name}-lane-${lane}`;
export const laneContainerName = (lane, svc) => `lane-${lane}-${svc}`;
export const laneComposeFile = (p, lane) => path.join(p.paths.lanesDir, lane, 'compose.json');

/**
 * The fully resolved compose model of a checkout. Always resolved under the baseline's project
 * name, so network and volume names match the running baseline even for lane checkouts.
 */
export function composeConfig(p, worktree) {
  const files = p.compose.files.map((f) => path.join(worktree, f));
  const args = ['compose', '-p', p.compose.project, ...files.flatMap((f) => ['-f', f]), 'config', '--format', 'json'];
  return JSON.parse(run('docker', args, { cwd: path.dirname(files[0]) }).stdout);
}

function networkKeys(def) {
  if (!def.networks) return ['default'];
  return Array.isArray(def.networks) ? def.networks : Object.keys(def.networks);
}

/** Every "host:port" a service can be reached at on the compose network, for routed services. */
function routeTargets(p, c) {
  const targets = new Set();
  for (const s of routedServices(p)) {
    const def = c.services[s.name];
    if (!def) continue;
    const hosts = new Set([s.name, def.container_name].filter(Boolean));
    if (def.networks && !Array.isArray(def.networks)) {
      for (const n of Object.values(def.networks)) for (const a of n?.aliases ?? []) hosts.add(a);
    }
    for (const h of hosts) targets.add(`${h}:${s.port}`);
  }
  return targets;
}

export function rewriteValue(value, targets) {
  if (typeof value !== 'string') return value;
  return value.replace(/(^|[^A-Za-z0-9_.-])([A-Za-z0-9][A-Za-z0-9_.-]*):(\d+)(?!\d)/g, (m, pre, host, port) => (
    targets.has(`${host}:${port}`) ? `${pre}${ROUTER_HOST}:${port}` : m
  ));
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Adds every lane's UI origins to a service's CORS allow-list. */
function applyCors(p, svc, env) {
  const c = svc.cors;
  if (!c) return;
  const existing = splitList(c.from.map((k) => env[k]).find(Boolean) || c.default);
  const extra = [];
  for (let n = 1; n <= p.lanes.max; n++) for (const u of c.uis) extra.push(localUrl(lanePorts(p, n).ui[u]));
  const list = [...new Set([...existing, ...extra])].join(',');
  if (c.springProperty) mergeSpringJson(env, { [c.springProperty]: list });
  else env[c.env] = list;
}

/** Env changes every routed instance gets, baseline or lane: URLs through the router, CORS. */
function routedEnv(p, svc, env, worktree, targets) {
  for (const k of Object.keys(env)) env[k] = rewriteValue(env[k], targets);
  if (svc.runtime === 'java' && p.runtimes.java.springDefaults) {
    for (const [k, v] of Object.entries(springUrlDefaults(worktree, svc, targets, ROUTER_HOST))) if (env[k] === undefined) env[k] = v;
  }
  applyCors(p, svc, env);
}

function dropMemorySettings(s) {
  delete s.mem_reservation;
  if (s.deploy?.resources) {
    delete s.deploy.resources.limits?.memory;
    delete s.deploy.resources.reservations?.memory;
  }
}

function routerService(p, networks) {
  return {
    image: 'nginx:1.27-alpine',
    container_name: routerContainer(p),
    restart: 'unless-stopped',
    volumes: [{ type: 'bind', source: p.paths.routerDir, target: '/etc/nginx/conf.d', read_only: true }],
    ports: routerPorts(p, routedServices(p)).map((port) => ({ target: port, published: String(port), protocol: 'tcp' })),
    networks: Object.fromEntries(networks.map((n) => [n, { aliases: [ROUTER_HOST] }])),
    labels: { [LABELS.role]: 'router', [LABELS.project]: p.name },
    healthcheck: {
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8099/__router/health'],
      interval: '10s',
      timeout: '3s',
      retries: 3,
    },
  };
}

export function generateBaselineCompose(p, { heavy = false } = {}) {
  const wt = p.paths.baselineWorktree;
  const c = composeConfig(p, wt);
  for (const name of Object.keys(c.services)) if (p.compose.exclude.includes(name)) delete c.services[name];
  for (const s of Object.values(c.services)) {
    if (!s.depends_on) continue;
    for (const dep of Object.keys(s.depends_on)) if (!c.services[dep]) delete s.depends_on[dep];
  }
  const missing = routedServices(p).filter((s) => !c.services[s.name]).map((s) => s.name);
  if (missing.length) throw new UsageError(`Routed services missing from the compose files: ${missing.join(', ')}`);

  const targets = routeTargets(p, c);
  const routerNets = [...new Set(routedServices(p).flatMap((s) => networkKeys(c.services[s.name])))];
  for (const [name, s] of Object.entries(c.services)) {
    s.labels = { ...(s.labels || {}), [LABELS.role]: 'baseline', [LABELS.project]: p.name, [LABELS.service]: name };
    if (s.build) s.image = `${p.name}-baseline-${name}:latest`;
    const env = { ...(s.environment || {}) };
    for (const k of Object.keys(env)) env[k] = rewriteValue(env[k], targets);
    const svc = p.services[name];
    if (svc?.route) {
      delete s.ports;
      routedEnv(p, svc, env, wt, targets);
    }
    if (svc?.runtime === 'java') {
      const jto = heavy ? env.JAVA_TOOL_OPTIONS || '' : heapFlags(svc.heap.baseline);
      if (!heavy) {
        s.mem_limit = memLimit(p, svc.heap.baseline);
        dropMemorySettings(s);
      }
      attachAgent(p, s, name, env, jto);
    }
    s.environment = env;
    if (p.compose.overrides[name]) c.services[name] = deepMerge(s, p.compose.overrides[name]);
  }
  c.services['lane-router'] = routerService(p, routerNets);
  writeJson(p.paths.baselineCompose, c);
  return c;
}

// Keys a lane copy must not inherit: they would clash with the baseline instance or its lifecycle.
const LANE_DROP = ['ports', 'container_name', 'depends_on', 'networks', 'links', 'profiles', 'restart', 'image', 'deploy', 'mem_reservation', 'scale'];

export function generateLaneCompose(p, lane, { jobs = false } = {}) {
  const c = composeConfig(p, lane.worktree);
  const targets = routeTargets(p, c);
  const ports = lanePorts(p, lane.number);
  const out = { name: laneProject(p, lane.name), services: {}, networks: {} };
  const volumes = {};
  for (const name of lane.services) {
    const s = c.services[name];
    const svc = p.services[name];
    if (!s) throw new UsageError(`${name} is not defined in ${p.compose.files.join(', ')} of ${lane.worktree}.`);
    if (!s.build) throw new UsageError(`${name} has no build section, so lanes can't build it from ${lane.worktree}.`);
    const container = laneContainerName(lane.name, name);
    const env = { ...(s.environment || {}), LANES_LANE: lane.name };
    routedEnv(p, svc, env, lane.worktree, targets);
    Object.assign(env, svc.laneEnv);
    if (!jobs) {
      Object.assign(env, svc.jobsOff.env);
      mergeSpringJson(env, svc.jobsOff.spring);
    }
    const def = Object.fromEntries(Object.entries(s).filter(([k, v]) => !LANE_DROP.includes(k) && v !== null));
    def.image = `${laneProject(p, lane.name)}-${name}:latest`;
    def.container_name = container;
    def.restart = 'no';
    def.labels = {
      ...(s.labels || {}),
      [LABELS.role]: 'lane',
      [LABELS.project]: p.name,
      [LABELS.lane]: lane.name,
      [LABELS.service]: name,
      [LABELS.worktree]: lane.worktree,
    };
    def.networks = {};
    for (const n of networkKeys(s)) {
      def.networks[n] = { aliases: [container] };
      out.networks[n] = { external: true, name: c.networks?.[n]?.name ?? `${p.compose.project}_${n}` };
    }
    def.volumes = [...(s.volumes || [])];
    for (const v of def.volumes) {
      if (v.type === 'volume' && v.source) volumes[v.source] = { external: true, name: c.volumes?.[v.source]?.name ?? `${p.compose.project}_${v.source}` };
    }
    if (svc.runtime === 'java') {
      def.mem_limit = memLimit(p, svc.heap.lane);
      def.ports = [{ target: p.runtimes.java.debugPort, published: String(ports.debug(name)), protocol: 'tcp' }];
      attachAgent(p, def, name, env, `${heapFlags(svc.heap.lane)} ${debugFlags(p)}`);
    }
    def.environment = env;
    // The service key becomes a DNS alias. Keying by the baseline name would make that name resolve
    // to this lane's container too, and the router would spread baseline traffic into the lane.
    out.services[container] = def;
  }
  if (Object.keys(volumes).length) out.volumes = volumes;
  const file = laneComposeFile(p, lane.name);
  writeJson(file, out);
  return file;
}
