import fs from 'node:fs';
import path from 'node:path';
import { run, runInherit } from '../core/exec.mjs';
import { UsageError, sanitizeLaneName, readJson } from '../core/util.mjs';
import { withLock } from '../core/lock.mjs';
import { samePath, pidAlive } from '../platform/index.mjs';
import { resolveServiceName, entryServices } from '../config/load.mjs';
import { detectChanges, fetchRefs } from '../git/repo.mjs';
import { prepareWorktree, teardownWorktree, applySparse } from '../git/protect.mjs';
import { generateLaneCompose, laneComposeFile, laneContainerName, laneProject, routerContainer, baselineContainerName } from '../stack/compose.mjs';
import { writeRouterConf, reloadRouter, routerRunning } from '../router/nginx.mjs';
import { ensureAgent } from '../runtimes/java.mjs';
import { containerHealth, imageExists } from '../docker/containers.mjs';
import { buildFingerprints } from '../stack/buildcache.mjs';
import { startDevServer, stopDevServer } from '../ui/devserver.mjs';
import { lanePorts, localUrl } from '../project/ports.mjs';
import { loadRegistry, updateRegistry, freeLaneNumber, laneForWorktree } from '../state/registry.mjs';
import { collectState } from '../state/collect.mjs';
import {
  log, warn, currentWorktree, resolveLane, assertOwnLane, composeArgs, memoryGuard, waitForContainers, waitForPorts, dockerLogsTail,
} from '../cli/context.mjs';

function printDetection(p, wt, det, services) {
  const { gap } = det;
  log(`Worktree : ${wt.top}`);
  log(`Branch   : ${wt.branch || '(detached)'} @ ${wt.head}`);
  log(`Compared : ${det.base.slice(0, 9)} (fork point from ${p.refs.laneBase})`);
  log(`Changed services : ${det.services.length ? det.services.join(', ') : '(none)'}`);
  log(`Changed UIs      : ${det.uis.length ? det.uis.join(', ') : '(none)'}`);
  for (const s of det.shared) warn(`${s.path} changed${s.note ? ` (${s.note})` : ''}. Add the services your test needs with --include.`);
  if (det.other.length) log(`Other changed paths (not lane-runnable): ${det.other.join(', ')}`);
  const missing = gap.filter((s) => !services.has(s));
  if (missing.length) {
    warn(`these services differ between ${p.refs.baseline} and your fork point but are not in this lane: ${missing.join(', ')}. If your change depends on that code, add them with --include ${missing.join(',')}`);
  }
}

export async function cmdDetect(p, pos, opts) {
  const wt = currentWorktree(p, opts);
  const det = await detectChanges(wt.top, p);
  printDetection(p, wt, det, new Set(det.services));
  const lane = laneForWorktree(loadRegistry(p), wt.top);
  if (lane) log(`Registered lane: ${lane.name} (#${lane.number}) running ${lane.services.join(', ') || 'no services'}`);
}

/** Placeholder values for UI commands and env, for a lane (or the baseline when lane is null). */
function uiVars(p, { lane, port, runningUis }) {
  const ports = lane ? lanePorts(p, lane.number) : null;
  return (key) => {
    if (key === 'port') return port;
    if (key === 'lane') return lane?.name ?? '';
    const [kind, name] = key.split(':');
    if (kind === 'entry' && p.services[name]) {
      return localUrl(ports && ports.entry[name] ? ports.entry[name] : p.services[name].port);
    }
    if (kind === 'ui' && p.uis[name]) return localUrl(ports && runningUis.includes(name) ? ports.ui[name] : p.uis[name].port);
    return undefined;
  };
}

function wantedServices(p, det, opts) {
  const services = new Set(det.services);
  for (const s of opts.include || []) {
    const name = resolveServiceName(p, s);
    if (!p.services[name].route) throw new UsageError(`${name} is not routed (route: false), so it can't run in a lane.`);
    services.add(name);
  }
  for (const s of opts.exclude || []) services.delete(resolveServiceName(p, s));
  return services;
}

function wantedUis(p, det, opts) {
  if (opts.noui) return [];
  const uis = new Set(det.uis);
  if (Array.isArray(opts.ui)) {
    const list = opts.ui.length ? opts.ui : Object.keys(p.uis);
    for (const k of list) {
      if (!p.uis[k]) throw new UsageError(`Unknown UI "${k}". UIs: ${Object.keys(p.uis).join(', ') || '(none configured)'}`);
      uis.add(k);
    }
  }
  return [...uis].sort();
}

export async function cmdUp(p, pos, opts) {
  const wt = currentWorktree(p, opts);
  if (samePath(wt.top, p.paths.baselineWorktree)) throw new UsageError('The baseline worktree cannot be a lane.');
  if (!(await routerRunning(p))) throw new UsageError('The baseline stack is not running in lanes mode (router is down). Ask the user to run: lanes baseline up');

  const det = await detectChanges(wt.top, p);
  const services = wantedServices(p, det, opts);
  const uis = wantedUis(p, det, opts);
  printDetection(p, wt, det, services);
  if (!services.size && !uis.length) throw new UsageError('Nothing to run: no lane-capable service or UI changed. Use --include <svc> or --ui <key> to force.');
  const name = sanitizeLaneName(opts.name || wt.branch || path.basename(wt.top));

  const reg0 = loadRegistry(p);
  const existing = reg0.lanes[name];
  if (existing && !samePath(existing.worktree, wt.top)) throw new UsageError(`Lane name "${name}" is already used by ${existing.worktree}. Pass --name <other>.`);
  const other = laneForWorktree(reg0, wt.top);
  if (other && other.name !== name) throw new UsageError(`This worktree already runs lane "${other.name}". Use --name ${other.name} or "lanes down" first.`);

  if (!opts.force) {
    const prior = existing?.services || [];
    const states = await Promise.all(prior.map((s) => containerHealth(laneContainerName(name, s))));
    const running = new Set(prior.filter((s, i) => states[i].status === 'running'));
    const newJava = [...services].filter((s) => !running.has(s) && p.services[s].runtime === 'java');
    const newUis = uis.filter((k) => !pidAlive(existing?.ui?.[k]?.pid));
    const guard = await memoryGuard(p, { javaServices: newJava, uiKeys: newUis });
    if (guard.problems.length) {
      throw new UsageError(`Not enough memory to start this lane safely:\n  - ${guard.problems.join('\n  - ')}\nClose a finished lane or free memory. Agents: stop and ask the user. Users: --force overrides.`);
    }
  }

  const lane = await updateRegistry(p, (reg) => {
    const cur = reg.lanes[name];
    const number = cur?.number ?? freeLaneNumber(p, reg);
    if (!number) throw new UsageError(`All ${p.lanes.max} lanes are in use. Close a finished lane first (lanes status).`);
    reg.lanes[name] = {
      ...(cur || {}),
      name,
      number,
      worktree: wt.top,
      branch: wt.branch || null,
      head: wt.head,
      services: [...services].sort(),
      jobs: !!opts.jobs,
      status: 'starting',
      createdAt: cur?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return reg.lanes[name];
  });
  const ports = lanePorts(p, lane.number);
  log(`\nLane "${name}" -> #${lane.number}`);

  const prep = prepareWorktree(p, wt.top);
  if (prep.protect.total) log(`Protected files: ${prep.protect.marked} hidden from git status.`);

  const project = laneProject(p, name);
  const file = laneComposeFile(p, name);
  if (services.size) {
    if ([...services].some((s) => p.services[s].runtime === 'java')) await ensureAgent(p, log);
    generateLaneCompose(p, lane, { jobs: !!opts.jobs });
    const prints = buildFingerprints(p, {
      worktree: wt.top,
      head: wt.sha,
      dirty: det.dirty,
      protectedFiles: prep.protect.files || [],
      compose: readJson(file),
      keyOf: (s) => laneContainerName(name, s),
    });
    const built = lane.builds || {};
    const reusable = await Promise.all([...services].map(async (s) => !opts.rebuild && built[s] === prints[s]
      && await imageExists(`${project}-${s}:latest`)));
    const toBuild = [...services].filter((s, i) => !reusable[i]);
    if (opts.nobuild || !toBuild.length) {
      if (!opts.nobuild) log(`No changes since the last build of ${[...services].join(', ')}; reusing images (--rebuild forces a build).`);
    } else {
      await withLock(p.paths.state, 'build', async () => {
        const skipped = [...services].filter((s) => !toBuild.includes(s));
        log(`Building ${toBuild.join(', ')} from ${wt.top}${skipped.length ? ` (unchanged, reused: ${skipped.join(', ')})` : ''} ...`);
        const keys = toBuild.map((s) => laneContainerName(name, s));
        if (runInherit('docker', composeArgs(project, file, 'build', ...keys)) !== 0) throw new Error(`docker compose build failed for lane ${name}`);
      });
      await updateRegistry(p, (reg) => {
        const l = reg.lanes[name];
        l.builds = { ...(l.builds || {}), ...Object.fromEntries(toBuild.map((s) => [s, prints[s]])) };
      });
    }
    if (runInherit('docker', composeArgs(project, file, 'up', '-d', '--remove-orphans')) !== 0) throw new Error(`docker compose up failed for lane ${name}`);
  } else if (fs.existsSync(file)) {
    runInherit('docker', composeArgs(project, file, 'down', '--rmi', 'all', '--remove-orphans'));
  }

  const ui = { ...(lane.ui || {}) };
  for (const key of Object.keys(ui)) {
    if (uis.includes(key)) continue;
    stopDevServer(ui[key].pid);
    delete ui[key];
  }
  for (const key of uis) {
    if (ui[key] && pidAlive(ui[key].pid)) continue;
    const def = p.uis[key];
    const port = ports.ui[key];
    ui[key] = startDevServer(p, def, {
      checkout: wt.top,
      port,
      env: { ...def.env, ...def.laneEnv },
      vars: uiVars(p, { lane, port, runningUis: uis }),
      logName: `lane-${name}-${key}-ui`,
    });
    log(`Started ${def.label} dev server (pid ${ui[key].pid}) on :${port}, log ${ui[key].log}`);
  }

  await updateRegistry(p, (reg) => {
    reg.lanes[name] = { ...reg.lanes[name], ui, status: 'running', updatedAt: new Date().toISOString() };
    writeRouterConf(p, reg);
  });
  await reloadRouter(p, { onlyIfChanged: true });

  let failed = false;
  if (!opts.nowait) {
    if (services.size) {
      log('\nWaiting for lane services to become healthy...');
      const res = await waitForContainers([...services].map((s) => laneContainerName(name, s)), 10 * 60 * 1000);
      for (const f of res.failed) {
        failed = true;
        log(`\nFAILED: ${f.name} is ${f.status}${f.health ? ` (${f.health})` : ''}. Last log lines:`);
        dockerLogsTail(f.name);
      }
      for (const t of res.timedOut) {
        failed = true;
        log(`\nTIMED OUT waiting for ${t}. Check: lanes logs ${t.replace(`lane-${name}-`, '')}`);
      }
    }
    const uiPorts = Object.values(ui).map((u) => u.port);
    if (uiPorts.length) {
      log('Waiting for UI dev servers (the first start of a checkout takes several minutes)...');
      for (const port of await waitForPorts(uiPorts, 10 * 60 * 1000)) {
        failed = true;
        log(`UI on :${port} is not listening yet. Check its log in ${p.paths.logs}.`);
      }
    }
  }

  log(`\nLane "${name}" (#${lane.number}) ${failed ? 'started with problems' : 'is up'}.`);
  for (const s of services) {
    const debug = p.services[s].runtime === 'java' ? `  debug localhost:${ports.debug(s)}` : '';
    log(`  ${s.padEnd(22)} container ${laneContainerName(name, s)}${debug}`);
  }
  for (const [key, u] of Object.entries(ui)) log(`  ${`${p.uis[key].label} UI`.padEnd(22)} ${localUrl(u.port)}`);
  for (const [svc, port] of Object.entries(ports.entry)) log(`  ${`${svc} entry`.padEnd(22)} ${localUrl(port)}   (always routes as lane ${name})`);
  const firstEntry = entryServices(p)[0];
  if (firstEntry) log(`  ${'Browser cookie'.padEnd(22)} ${localUrl(firstEntry.port)}/__lane/${name}   (clear: /__lane/off)`);
  log(`  ${'Header'.padEnd(22)} baggage: ${p.routing.baggageKey}=${name}`);
  if (failed) process.exitCode = 1;
}

export async function cmdDown(p, pos, opts) {
  const lane = resolveLane(p, loadRegistry(p), opts);
  assertOwnLane(p, lane, opts);
  const file = laneComposeFile(p, lane.name);
  if (fs.existsSync(file)) runInherit('docker', composeArgs(laneProject(p, lane.name), file, 'down', '--rmi', 'all', '--remove-orphans'));
  for (const u of Object.values(lane.ui || {})) if (stopDevServer(u.pid)) log(`Stopped UI dev server pid ${u.pid} (:${u.port})`);
  await updateRegistry(p, (reg) => {
    delete reg.lanes[lane.name];
    writeRouterConf(p, reg);
  });
  await reloadRouter(p);
  log(`Lane "${lane.name}" closed: containers removed, UI dev servers stopped, lane #${lane.number} freed. Worktree kept at ${lane.worktree}.`);
}

const fmtMb = (bytes) => (bytes == null ? '' : `${Math.round(bytes / 1024 / 1024)} MB`);
const uiWord = (u) => (u.listening ? 'listening' : u.alive ? 'starting' : 'stopped');

export async function cmdStatus(p, pos, opts) {
  const st = await collectState(p);
  if (opts.json) {
    log(JSON.stringify(st, null, 2));
    return;
  }
  const b = st.baseline;
  const running = b.containers.filter((c) => c.state === 'running').length;
  log(`Project  : ${p.name} (${p.repo})`);
  log(`Baseline : ${b.mode} mode | ${running}/${b.containers.length} containers running | ref ${b.ref || p.refs.baseline}${b.head ? ` @ ${b.head}` : ''}${b.heavy ? ' | heavy heaps' : ''}`);
  const bad = b.containers.filter((c) => c.state !== 'running' && !/init/.test(c.name));
  if (bad.length) log(`           not running: ${bad.map((c) => c.name).join(', ')}`);
  log(`Router   : ${st.router ? `${st.router.state}${st.router.health ? ` (${st.router.health})` : ''}` : 'absent'}`);
  for (const [k, u] of Object.entries(b.ui)) if (u) log(`Baseline ${k} UI: :${u.port} ${uiWord(u)} (pid ${u.pid})`);
  if (st.memory) {
    const m = st.memory;
    log(`Memory   : host free ${m.hostFreeGb}/${m.hostTotalGb} GB | docker ${m.dockerUsedGb}/${m.dockerTotalGb} GB (${m.dockerPercent ?? '?'}%)`);
  }
  log(`Lanes    : ${st.lanes.length}/${p.lanes.max}`);
  for (const l of st.lanes) {
    log(`  [${l.number}] ${l.name}  (${l.status})  ${l.branch || '(detached)'}  ${l.worktree}`);
    for (const s of l.services) {
      log(`      ${s.service.padEnd(22)} ${s.state}${s.health ? `/${s.health}` : ''}${s.debugPort ? `  debug :${s.debugPort}` : ''}  ${fmtMb(s.memBytes)}`);
    }
    for (const [k, u] of Object.entries(l.ui)) if (u) log(`      ${`${k} UI`.padEnd(22)} ${localUrl(u.port)}  ${uiWord(u)}`);
    const entries = Object.entries(l.urls.entry).map(([svc, url]) => `${svc} ${url}`).join(', ');
    if (entries) log(`      entry: ${entries}`);
    if (l.urls.cookieOn) log(`      cookie: ${l.urls.cookieOn}`);
  }
  if (st.orphans.length) log(`Orphan lane containers (no registry entry): ${st.orphans.map((c) => c.name).join(', ')}`);
}

export async function cmdLogs(p, pos, opts) {
  const raw = pos[0];
  if (!raw) throw new UsageError('Usage: lanes logs <service|router> [--lane n | --baseline] [--tail 200] [--follow]');
  const reg = loadRegistry(p);
  let container = /^(lane-)?router$/i.test(raw) ? routerContainer(p) : null;
  let svc = raw;
  try {
    svc = resolveServiceName(p, raw);
  } catch {
    svc = raw;
  }
  if (!container && !opts.baseline) {
    let lane = null;
    if (opts.lane) lane = reg.lanes[sanitizeLaneName(opts.lane)] || null;
    else {
      try {
        lane = laneForWorktree(reg, currentWorktree(p, opts).top);
      } catch {
        lane = null;
      }
    }
    if (lane && lane.services.includes(svc)) container = laneContainerName(lane.name, svc);
    else if (opts.lane) throw new UsageError(`Lane "${opts.lane}" does not run ${svc}.`);
  }
  container ||= baselineContainerName(p, svc);
  log(`--- docker logs ${container} ---`);
  const args = ['logs', '--tail', String(opts.tail || 200)];
  if (opts.follow) args.push('-f');
  process.exitCode = runInherit('docker', [...args, container]);
}

export async function cmdNew(p, pos, opts) {
  const branch = pos[0];
  if (!branch) throw new UsageError('Usage: lanes new <branch> [--name n] [--from <ref>]');
  const name = sanitizeLaneName(opts.name || branch);
  const dir = path.join(p.worktree.dir, name);
  if (fs.existsSync(dir)) throw new UsageError(`${dir} already exists.`);
  const from = opts.from || p.refs.laneBase;
  const exists = run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: p.repo, allowFail: true }).ok;
  const noCheckout = p.worktree.sparse?.length ? ['--no-checkout'] : [];
  const args = exists ? ['worktree', 'add', ...noCheckout, dir, branch] : ['worktree', 'add', ...noCheckout, '-b', branch, dir, from];
  run('git', args, { cwd: p.repo });
  if (applySparse(p, dir)) {
    run('git', ['checkout'], { cwd: dir });
    log(`Sparse checkout: ${p.worktree.sparse.join(' ')}`);
  }
  const prep = prepareWorktree(p, dir);
  log(`Worktree ready: ${dir} (branch ${branch}${exists ? '' : ` from ${from}`}).${prep.protect.total ? ` Protected files hidden: ${prep.protect.marked}.` : ''}`);
  log('Make your changes there, then run "lanes up" from that folder.');
}

export async function cmdSync(p, pos, opts) {
  const wt = currentWorktree(p, opts);
  const f = fetchRefs(wt.top, [p.refs.laneBase, p.refs.baseline]);
  if (!f.ok) warn(`git fetch failed (${f.message}). Continuing with the last fetched refs.`);
  teardownWorktree(p, wt.top);
  let r;
  if (opts.onto) r = run('git', ['rebase', '--autostash', opts.onto], { cwd: wt.top, allowFail: true });
  else if (run('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd: wt.top, allowFail: true }).ok) {
    r = run('git', ['pull', '--rebase', '--autostash'], { cwd: wt.top, allowFail: true });
  } else r = run('git', ['rebase', '--autostash', p.refs.laneBase], { cwd: wt.top, allowFail: true });
  log((r.stdout + r.stderr).trim());
  if (!r.ok) {
    process.exitCode = 1;
    log('\nSync stopped (conflicts?). The worktree setup is undone so you can resolve cleanly; run "lanes setup on" when done.');
    return;
  }
  const prep = prepareWorktree(p, wt.top);
  log(`Synced.${prep.protect.total ? ` Protected files hidden again: ${prep.protect.marked}.` : ''}`);
}
