import { entryServices } from '../config/load.mjs';

/**
 * Lane N's ports are its base port plus N x portStride: entry ports for services marked
 * `entry: true`, UI dev server ports, and a debugger port per Java service.
 */
export function lanePorts(p, n) {
  const off = p.lanes.portStride * n;
  const entry = {};
  for (const s of entryServices(p)) entry[s.name] = off + s.port;
  const ui = {};
  for (const u of Object.values(p.uis)) ui[u.key] = off + u.port;
  return {
    entry,
    ui,
    debug: (svc) => off + 5000 + (p.services[svc].port % 1000),
  };
}

/** Every port the router publishes: service ports, plus every lane's entry ports. */
export function routerPorts(p, routed) {
  const ports = routed.map((s) => s.port);
  for (let n = 1; n <= p.lanes.max; n++) ports.push(...Object.values(lanePorts(p, n).entry));
  return ports;
}

export const localUrl = (port) => `http://localhost:${port}`;
