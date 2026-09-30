import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, parseSizeMb } from '../core/util.mjs';

const AGENT_DIR_IN_CONTAINER = '/otel';
const AGENT_JAR = `${AGENT_DIR_IN_CONTAINER}/opentelemetry-javaagent.jar`;

// The agent only carries the baggage header from incoming to outgoing calls: nothing is exported.
const OTEL_ENV = {
  OTEL_TRACES_EXPORTER: 'none',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_LOGS_EXPORTER: 'none',
  OTEL_PROPAGATORS: 'tracecontext,baggage',
  OTEL_INSTRUMENTATION_MICROMETER_ENABLED: 'false',
  OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED: 'false',
  OTEL_INSTRUMENTATION_LOGBACK_APPENDER_ENABLED: 'false',
};

export function agentDir(p) {
  const j = p.runtimes.java;
  return j.agentPath ? path.dirname(j.agentPath) : path.join(p.paths.cache, 'otel', j.agentVersion);
}

export function agentJar(p) {
  return p.runtimes.java.agentPath || path.join(agentDir(p), 'opentelemetry-javaagent.jar');
}

export const usesJava = (p) => Object.values(p.services).some((s) => s.runtime === 'java');

/** Downloads the pinned OpenTelemetry Java agent into the lanes cache the first time it's needed. */
export async function ensureAgent(p, log = console.log) {
  const jar = agentJar(p);
  if (fs.existsSync(jar) && fs.statSync(jar).size > 1_000_000) return { jar, downloaded: false };
  if (p.runtimes.java.agentPath) throw new Error(`runtimes.java.agentPath points at ${jar}, which does not exist.`);
  const v = p.runtimes.java.agentVersion;
  const url = `https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${v}/opentelemetry-javaagent.jar`;
  log(`Downloading the OpenTelemetry Java agent ${v} (one time, about 25 MB)...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading ${url} failed: HTTP ${res.status}. Set runtimes.java.agentPath to a local copy.`);
  ensureDir(path.dirname(jar));
  const tmp = `${jar}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, jar);
  return { jar, downloaded: true };
}

export function mergeSpringJson(env, props) {
  if (!props || !Object.keys(props).length) return;
  let current = {};
  if (env.SPRING_APPLICATION_JSON) {
    try {
      current = JSON.parse(env.SPRING_APPLICATION_JSON);
    } catch {
      current = {};
    }
  }
  env.SPRING_APPLICATION_JSON = JSON.stringify({ ...current, ...props });
}

export function memLimit(p, heap) {
  return `${parseSizeMb(heap) + p.runtimes.java.memOverheadMb}m`;
}

/** Heap flags: a small initial heap, so idle services stay small, capped at the maximum. */
export function heapFlags(heap) {
  return `-Xms${Math.min(128, parseSizeMb(heap))}m -Xmx${heap}`;
}

/**
 * Attaches the agent to a compose service: JAVA_TOOL_OPTIONS carries the heap/debug flags and
 * -javaagent, and the agent folder is bind-mounted read-only.
 */
export function attachAgent(p, service, svcName, env, jto) {
  env.JAVA_TOOL_OPTIONS = `${jto} -javaagent:${AGENT_JAR}`.trim();
  env.OTEL_SERVICE_NAME = svcName;
  Object.assign(env, OTEL_ENV);
  service.volumes = [
    ...(service.volumes || []).filter((v) => v.target !== AGENT_DIR_IN_CONTAINER),
    { type: 'bind', source: agentDir(p), target: AGENT_DIR_IN_CONTAINER, read_only: true },
  ];
}

export function debugFlags(p) {
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${p.runtimes.java.debugPort}`;
}

/**
 * Spring `${VAR:http://host:port}` defaults in application*.yml that point at a routed service.
 * They bypass compose env, so the matching VAR is set explicitly to the router's address.
 */
export function springUrlDefaults(worktree, svc, targets, routerHost) {
  const found = {};
  for (const rel of svc.paths) {
    const dir = path.join(worktree, rel, 'src', 'main', 'resources');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => /^application.*\.(ya?ml|properties)$/.test(n))) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of txt.matchAll(/\$\{([A-Za-z0-9_.-]+):(https?:\/\/)([A-Za-z0-9_.-]+):(\d+)/g)) {
        if (targets.has(`${m[3]}:${m[4]}`) && /^[A-Z0-9_]+$/.test(m[1])) found[m[1]] = `${m[2]}${routerHost}:${m[4]}`;
      }
    }
  }
  return found;
}
