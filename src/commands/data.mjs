import fs from 'node:fs';
import path from 'node:path';
import { runWithFiles } from '../core/exec.mjs';
import { UsageError, ensureDir, sanitizeLaneName } from '../core/util.mjs';
import { baselineContainerName } from '../stack/compose.mjs';
import { containerHealth, listContainersAsync } from '../docker/containers.mjs';
import { log } from '../cli/context.mjs';

const USAGE = 'Usage: lanes data snapshot [--label x] | list | restore <snapshot> --yes';

function stores(p) {
  const list = Object.values(p.data);
  if (!list.length) throw new UsageError('No data stores configured. Add a "data" section to lanes.yml (see docs/config.md).');
  return list;
}

async function runningContainer(p, store) {
  const all = await listContainersAsync();
  const found = all.find((c) => c.project === p.compose.project && c.service === store.service && c.state === 'running');
  if (found) return found.name;
  const name = baselineContainerName(p, store.service);
  const h = await containerHealth(name);
  if (h.status !== 'running') throw new UsageError(`${store.service} (${name}) is not running; its data can't be read or written.`);
  return name;
}

function sizeMb(file) {
  return `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
}

async function snapshot(p, opts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(p.paths.snapshots, `${stamp}${opts.label ? `-${sanitizeLaneName(opts.label)}` : ''}`);
  ensureDir(dir);
  for (const store of stores(p)) {
    const container = await runningContainer(p, store);
    const file = path.join(dir, `${store.service}.${store.ext}`);
    log(`Dumping ${store.service} ...`);
    const r = runWithFiles('docker', ['exec', container, 'sh', '-c', store.dump], { stdoutFile: file });
    if (r.code !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`Dump of ${store.service} failed (exit ${r.code}):\n${r.stderr.trim()}`);
    }
    log(`  ${file} (${sizeMb(file)})`);
  }
  log(`Snapshot ${path.basename(dir)} saved.`);
}

function list(p) {
  const root = p.paths.snapshots;
  const names = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()).sort() : [];
  if (!names.length) {
    log('No snapshots yet. Take one with: lanes data snapshot --label <why>');
    return;
  }
  for (const n of names) {
    const files = fs.readdirSync(path.join(root, n));
    log(`${n}  ${files.map((f) => `${f} ${sizeMb(path.join(root, n, f))}`).join(', ')}`);
  }
}

async function restore(p, name, opts) {
  if (!name) throw new UsageError(USAGE);
  const dir = fs.existsSync(name) ? path.resolve(name) : path.join(p.paths.snapshots, name);
  if (!fs.existsSync(dir)) throw new UsageError(`Snapshot not found: ${name}. See: lanes data list`);
  if (!opts.yes) throw new UsageError(`Restoring overwrites the shared data of the baseline and every lane. Re-run with --yes to restore ${path.basename(dir)}.`);
  let restored = 0;
  for (const store of stores(p)) {
    const file = path.join(dir, `${store.service}.${store.ext}`);
    if (!fs.existsSync(file)) continue;
    const container = await runningContainer(p, store);
    log(`Restoring ${store.service} from ${path.basename(dir)} ...`);
    const r = runWithFiles('docker', ['exec', '-i', container, 'sh', '-c', store.restore], { stdinFile: file });
    if (r.code !== 0) throw new Error(`Restore of ${store.service} failed (exit ${r.code}):\n${r.stderr.trim()}`);
    restored++;
  }
  if (!restored) throw new UsageError(`${path.basename(dir)} has no dump for any configured store.`);
  log('Restore finished.');
}

/** lanes data: snapshots of the shared data stores, so tests that write a lot can be undone. */
export async function cmdData(p, pos, opts) {
  const action = pos[0] || 'list';
  if (action === 'snapshot') return snapshot(p, opts);
  if (action === 'list') return list(p);
  if (action === 'restore') return restore(p, pos[1], opts);
  throw new UsageError(USAGE);
}
