import { readJson } from '../core/util.mjs';
import { pidAlive } from '../platform/index.mjs';
import { entryServices, routedServices } from '../config/load.mjs';
import { lanePorts, localUrl } from '../project/ports.mjs';
import { listContainersAsync, containerMemoryAsync, dockerMemTotalAsync, memorySnapshotFrom } from '../docker/containers.mjs';
import { LABELS, laneContainerName, routerContainer } from '../stack/compose.mjs';
import { portOpen } from '../ui/devserver.mjs';
import { loadRegistry } from './registry.mjs';

async function uiState(ui) {
  if (!ui) return null;
  const alive = pidAlive(ui.pid);
  return { ...ui, alive, listening: alive ? await portOpen(ui.port) : false };
}

async function uiStates(map) {
  const out = {};
  for (const [k, u] of Object.entries(map || {})) out[k] = await uiState(u);
  return out;
}

/** One snapshot of everything: baseline, router, lanes, memory. Shared by `lanes status` and the dashboard. */
export async function collectState(p, { withMemory = true } = {}) {
  const reg = loadRegistry(p);
  const containers = await listContainersAsync();
  const [mem, dockerTotal] = await Promise.all([
    withMemory ? containerMemoryAsync(containers) : {},
    withMemory ? dockerMemTotalAsync() : 0,
  ]);
  const withMem = (c) => (c ? { ...c, memBytes: mem[c.name]?.bytes ?? null, cpu: mem[c.name]?.cpu ?? null } : null);
  const routerName = routerContainer(p);
  const firstEntry = entryServices(p)[0];

  const baselineContainers = containers
    .filter((c) => c.project === p.compose.project && c.name !== routerName)
    .map((c) => ({ ...withMem(c), lanesMode: c.labels[LABELS.role] === 'baseline' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const router = withMem(containers.find((c) => c.name === routerName));

  const lanes = [];
  for (const lane of Object.values(reg.lanes).sort((a, b) => a.number - b.number)) {
    const ports = lanePorts(p, lane.number);
    const services = lane.services.map((svc) => {
      const c = containers.find((x) => x.name === laneContainerName(lane.name, svc));
      return {
        service: svc,
        container: laneContainerName(lane.name, svc),
        state: c?.state ?? 'missing',
        health: c?.health ?? null,
        status: c?.status ?? 'not created',
        memBytes: c ? mem[c.name]?.bytes ?? null : null,
        debugPort: p.services[svc]?.runtime === 'java' ? ports.debug(svc) : null,
      };
    });
    lanes.push({
      ...lane,
      ports,
      services,
      ui: await uiStates(lane.ui),
      urls: {
        cookieOn: firstEntry ? `${localUrl(firstEntry.port)}/__lane/${lane.name}` : null,
        cookieOff: firstEntry ? `${localUrl(firstEntry.port)}/__lane/off` : null,
        ui: Object.fromEntries(Object.keys(lane.ui || {}).map((k) => [k, localUrl(lane.ui[k].port ?? ports.ui[k])])),
        entry: Object.fromEntries(Object.entries(ports.entry).map(([svc, port]) => [svc, localUrl(port)])),
      },
    });
  }

  const orphans = containers
    .filter((c) => c.labels[LABELS.role] === 'lane' && c.labels[LABELS.project] === p.name && !reg.lanes[c.labels[LABELS.lane]])
    .map((c) => withMem(c));

  return {
    generatedAt: new Date().toISOString(),
    project: {
      name: p.name,
      repo: p.repo,
      refs: p.refs,
      maxLanes: p.lanes.max,
      services: routedServices(p).map((s) => ({ name: s.name, port: s.port, entry: s.entry })),
      allServices: Object.keys(p.services),
      uis: Object.values(p.uis).map((u) => ({ key: u.key, label: u.label, port: u.port })),
    },
    baseline: {
      ...readJson(p.paths.baselineState, {}),
      worktree: p.paths.baselineWorktree,
      mode: router?.state === 'running' ? 'lanes' : baselineContainers.some((c) => c.state === 'running') ? 'normal' : 'down',
      containers: baselineContainers,
      ui: await uiStates(reg.baselineUi),
    },
    router,
    lanes,
    orphans,
    memory: withMemory ? memorySnapshotFrom(mem, dockerTotal) : null,
  };
}
