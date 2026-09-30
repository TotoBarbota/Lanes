import path from 'node:path';

const JAVA_HINT = /\b(java|jdk|jre|maven|mvn|gradle|gradlew|temurin|corretto|zulu|openjdk|liberica|semeru)\b|\.jar\b/i;

// Frontend dev servers: default port and how to pass another one.
const FRAMEWORKS = [
  { dep: 'gatsby', port: 8000, args: '-p {{port}}' },
  { dep: 'next', port: 3000, args: '-p {{port}}' },
  { dep: 'nuxt', port: 3000, args: '--port {{port}}' },
  { dep: 'astro', port: 4321, args: '--port {{port}}' },
  { dep: '@angular/cli', port: 4200, args: '--port {{port}}' },
  { dep: '@sveltejs/kit', port: 5173, args: '--port {{port}} --strictPort' },
  { dep: 'vite', port: 5173, args: '--port {{port}} --strictPort' },
  { dep: 'react-scripts', port: 3000, env: { PORT: '{{port}}', BROWSER: 'none' } },
];
const DEV_SCRIPTS = ['dev', 'develop', 'start', 'serve'];

const toPosix = (p) => p.split(path.sep).join('/');
const rel = (root, abs) => toPosix(path.relative(root, abs)) || '.';
const q = (s) => (/^[A-Za-z0-9_./@-]+$/.test(String(s)) ? String(s) : JSON.stringify(String(s)));

export function sanitizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';
}

function containerPort(s) {
  const p = s.ports?.find((x) => x.target) ?? null;
  if (p) return { port: Number(p.target), published: p.published ? Number(p.published) : null };
  const e = s.expose?.[0];
  return e ? { port: parseInt(String(e), 10), published: null } : null;
}

const ENV_FILES = ['.env', '.env.development', '.env.local', '.env.development.local', '.env.example'];

/** Variables in a UI's env files that point the browser at a local port: [{ name, port }]. */
function uiEnvTargets(u, readText) {
  const found = new Map();
  for (const f of ENV_FILES) {
    const text = readText(u.dir === '.' ? f : `${u.dir}/${f}`) || '';
    for (const m of text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/gm)) {
      if (!found.has(m[1])) found.set(m[1], Number(m[2]));
    }
  }
  return [...found].map(([name, port]) => ({ name, port }));
}

/** Folder whose changes should rebuild the service, relative to the repo root, or null if unknown. */
function servicePath(repoDir, s) {
  if (!s.build?.context) return null;
  const ctx = rel(repoDir, path.resolve(s.build.context));
  if (ctx.startsWith('..')) return null;
  if (ctx !== '.') return ctx;
  const df = s.build.dockerfile ? toPosix(path.dirname(s.build.dockerfile)) : '.';
  return df === '.' ? null : df;
}

function referencedServices(compose) {
  const names = new Map();
  for (const [name, s] of Object.entries(compose.services)) {
    names.set(name, name);
    if (s.container_name) names.set(s.container_name, name);
    for (const net of Object.values(s.networks || {})) for (const a of net?.aliases || []) names.set(a, name);
  }
  const hit = new Set();
  const re = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9][A-Za-z0-9_.-]*):(\d+)/g;
  for (const [caller, s] of Object.entries(compose.services)) {
    for (const v of Object.values(s.environment || {})) {
      for (const m of String(v ?? '').matchAll(re)) {
        const target = names.get(m[2]);
        if (target && target !== caller) hit.add(target);
      }
    }
  }
  return hit;
}

function detectUi(dir, pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = FRAMEWORKS.find((f) => deps[f.dep]);
  const script = DEV_SCRIPTS.find((s) => pkg.scripts?.[s]);
  if (!fw || !script) return null;
  const explicit = /(?:--port[= ]|-p |PORT=)(\d{2,5})/.exec(pkg.scripts[script]);
  return {
    dir,
    script,
    port: explicit ? Number(explicit[1]) : fw.port,
    command: fw.args ? `npm run ${script} -- ${fw.args}` : `npm run ${script}`,
    env: fw.env || null,
  };
}

/**
 * Drafts a lanes.yml from a resolved compose config (docker compose config --format json).
 * readText(relPath) returns a repo file's text or null; packages lists { dir, json } for
 * package.json files found in the repo; repoLine is set when the file lives outside the repo.
 * Returns { text, services, uis, notes }.
 */
export function draftConfig({ repoDir, repoLine = null, composeFile, compose, readText, packages = [], ref }) {
  const name = sanitizeName(path.basename(repoDir));
  const referenced = referencedServices(compose);
  const uis = [];
  const uiDirs = new Set();
  for (const { dir, json } of packages) {
    const ui = detectUi(dir, json);
    if (ui && !uiDirs.has(dir)) {
      uis.push({ ...ui, key: sanitizeName(path.basename(dir === '.' ? name : dir)) });
      uiDirs.add(dir);
    }
  }

  for (const u of uis) u.targets = uiEnvTargets(u, readText);
  const uiPorts = new Set(uis.flatMap((u) => u.targets.map((t) => t.port)));
  const services = [];
  const skipped = [];
  const exclude = [];
  for (const [svc, s] of Object.entries(compose.services)) {
    if (!s.build) continue;
    const dir = servicePath(repoDir, s);
    if (dir && uiDirs.has(dir)) {
      exclude.push(svc);
      continue;
    }
    const port = containerPort(s);
    if (!port) {
      skipped.push(svc);
      continue;
    }
    const df = s.build.dockerfile ? path.join(rel(repoDir, path.resolve(s.build.context)), s.build.dockerfile) : null;
    const dockerfile = (df && readText(toPosix(df))) || readText(`${dir || svc}/Dockerfile`) || '';
    const buildFiles = ['pom.xml', 'build.gradle', 'build.gradle.kts'].some((f) => readText(`${dir || svc}/${f}`) !== null);
    services.push({
      name: svc,
      port: port.port,
      hostPort: port.published,
      entry: (!!port.published && !referenced.has(svc)) || uiPorts.has(port.published) || uiPorts.has(port.port),
      java: JAVA_HINT.test(dockerfile) || buildFiles,
      paths: dir && dir !== svc ? [dir] : null,
    });
  }
  if (services.length && !services.some((s) => s.entry)) for (const s of services) s.entry = !referenced.has(s.name);

  const L = [];
  L.push('# lanes configuration, drafted by "lanes init". Review every line; docs/config.md explains all options.');
  L.push(`name: ${q(name)}`);
  if (repoLine) L.push(`repo: ${q(repoLine)}`);
  L.push('refs:');
  L.push(`  baseline: ${q(ref)}        # what the shared baseline stack runs`);
  L.push(`  laneBase: ${q(ref)}        # what task branches start from`);
  L.push('');
  L.push('compose:');
  L.push(`  files: [${q(composeFile)}]`);
  if (compose.name) L.push(`  project: ${q(compose.name)}    # the compose project name your stack already uses, so volumes are kept`);
  if (exclude.length) {
    L.push(`  exclude: [${exclude.map(q).join(', ')}]    # UIs below run as dev servers instead`);
  }
  L.push('');
  L.push('# Services a lane can run its own copy of. Each needs a build section and the port it listens on.');
  L.push('services:');
  if (!services.length) L.push('  {}    # no service with both a build section and a port was found');
  for (const s of services) {
    L.push(`  ${s.name}:`);
    L.push(`    port: ${s.port}`);
    if (s.entry) L.push('    entry: true          # called from outside the stack (browser, curl): gets a per-lane port');
    if (s.java) L.push('    runtime: java        # the OpenTelemetry agent carries the lane header to downstream calls');
    else L.push('    # runtime: none      # not Java: the app itself must forward the `baggage` header on outgoing calls');
    if (s.paths) L.push(`    paths: [${s.paths.map(q).join(', ')}]`);
  }
  for (const s of skipped) L.push(`  # ${s}: has a build section but no port, so lanes can't route to it. Add it with a port, or "route: false".`);

  if (uis.length) {
    L.push('');
    L.push('# Frontend dev servers. Each lane can run its own copy on its own port.');
    L.push('uis:');
    for (const u of uis) {
      L.push(`  ${u.key}:`);
      L.push(`    path: ${q(u.dir)}`);
      L.push(`    port: ${u.port}`);
      L.push(`    command: ${q(u.command)}`);
      if (u.env) {
        L.push('    env:');
        for (const [k, v] of Object.entries(u.env)) L.push(`      ${k}: ${q(v)}`);
      }
      const byPort = (port) => services.find((s) => s.hostPort === port || s.port === port);
      const laneEnv = u.targets.filter((t) => byPort(t.port));
      if (laneEnv.length) {
        L.push('    laneEnv:              # lane copies call their lane\'s own entry port (found in the UI\'s .env files)');
        for (const t of laneEnv) L.push(`      ${t.name}: "{{entry:${byPort(t.port).name}}}"`);
      } else {
        L.push('    # laneEnv:            # env only for lane copies, e.g. an API URL pointing at the lane entry port');
        const firstEntry = services.find((s) => s.entry);
        if (firstEntry) L.push(`    #   API_URL: "{{entry:${firstEntry.name}}}"`);
      }
    }
  }

  L.push('');
  L.push('# Shared code: changes here affect several services. lanes warns when they change.');
  L.push('# shared:');
  L.push('#   - path: libs/common');
  L.push('#     note: used by every Java service');

  const notes = [];
  if (!services.length) notes.push('No lane-capable service found. Services need a build section and a port (ports or expose).');
  if (skipped.length) notes.push(`Skipped (no port): ${skipped.join(', ')}.`);
  if (services.some((s) => !s.java)) notes.push('Non-Java services must forward the `baggage` header themselves for requests to stay in a lane.');
  return { text: `${L.join('\n')}\n`, services, uis, notes };
}
