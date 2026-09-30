import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { run, runShell, startDetached } from '../core/exec.mjs';
import { UsageError, ensureDir, fillTemplate } from '../core/util.mjs';
import { killTree, copyTree } from '../platform/index.mjs';
import { listWorktrees } from '../git/repo.mjs';

/**
 * Copies files listed in seedFromMain (typically a gitignored lockfile) from the main checkout
 * when this checkout lacks them and the package manifest is identical.
 */
function seedFromMain(ui, uiDir, mainUiDir) {
  if (!mainUiDir || path.resolve(mainUiDir) === path.resolve(uiDir)) return;
  const manifest = 'package.json';
  const same = (f) => fs.existsSync(path.join(mainUiDir, f)) && fs.existsSync(path.join(uiDir, f))
    && fs.readFileSync(path.join(mainUiDir, f), 'utf8') === fs.readFileSync(path.join(uiDir, f), 'utf8');
  if (!same(manifest)) return;
  for (const f of ui.seedFromMain) {
    const src = path.join(mainUiDir, f);
    const dst = path.join(uiDir, f);
    if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
    fs.copyFileSync(src, dst);
    console.log(`Copied ${f} from the main checkout (${manifest} is identical).`);
  }
}

function installCommand(ui, uiDir) {
  if (ui.install === false) return null;
  if (ui.install !== 'auto') return ui.install;
  const lockTracked = run('git', ['ls-files', '--error-unmatch', 'package-lock.json'], { cwd: uiDir, allowFail: true }).ok;
  return `npm ${lockTracked ? 'ci' : 'install'} --prefer-offline --no-audit --no-fund`;
}

const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

function readOrNull(f) {
  try {
    return fs.readFileSync(f);
  } catch {
    return null;
  }
}

function sameManifests(a, b) {
  return MANIFESTS.every((m) => {
    const x = readOrNull(path.join(a, m));
    const y = readOrNull(path.join(b, m));
    return x === null ? y === null : y !== null && x.equals(y);
  });
}

/**
 * Links inside node_modules (workspace packages, `npm link`) point at the donor's own files,
 * and a copy would silently keep pointing there.
 */
function hasLinks(nodeModules) {
  const linked = (dir) => fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isSymbolicLink()
    || (e.isDirectory() && e.name.startsWith('@') && linked(path.join(dir, e.name))));
  try {
    return linked(nodeModules);
  } catch {
    return true;
  }
}

/** Another checkout's installed copy of this UI with identical manifests, or null. */
function findDonor(ui, uiDir, candidateDirs) {
  if (!ui.reuseInstall || !ui.installedMarker.split(/[\\/]/)[0].startsWith('node_modules')) return null;
  for (const dir of candidateDirs) {
    if (!dir || path.resolve(dir) === path.resolve(uiDir)) continue;
    if (!fs.existsSync(path.join(dir, ui.installedMarker))) continue;
    if (!sameManifests(dir, uiDir) || hasLinks(path.join(dir, 'node_modules'))) continue;
    return dir;
  }
  return null;
}

function copyInstall(donor, uiDir) {
  const src = path.join(donor, 'node_modules');
  const dst = path.join(uiDir, 'node_modules');
  console.log(`Copying node_modules from ${donor} (identical package.json and lockfile) ...`);
  try {
    fs.rmSync(dst, { recursive: true, force: true });
    copyTree(src, dst, { skip: ['.cache'] });
    return true;
  } catch (e) {
    console.log(`Copy failed (${e.message}); installing instead.`);
    fs.rmSync(dst, { recursive: true, force: true });
    return false;
  }
}

/**
 * Makes sure the UI's dependencies are installed: already there, copied from another checkout
 * with identical manifests (a minute instead of a full install), or installed.
 */
export function ensureInstalled(ui, uiDir, mainUiDir, donorDirs = []) {
  if (fs.existsSync(path.join(uiDir, ui.installedMarker))) return false;
  seedFromMain(ui, uiDir, mainUiDir);
  const donor = findDonor(ui, uiDir, [mainUiDir, ...donorDirs]);
  if (donor && copyInstall(donor, uiDir) && fs.existsSync(path.join(uiDir, ui.installedMarker))) return true;
  const cmd = installCommand(ui, uiDir);
  if (!cmd) return false;
  console.log(`Installing dependencies in ${uiDir} (first run for this checkout, takes a few minutes): ${cmd}`);
  const code = runShell(cmd, { cwd: uiDir });
  if (code !== 0) throw new UsageError(`"${cmd}" failed in ${uiDir} (exit ${code}).`);
  return true;
}

/**
 * Starts a UI dev server in the background. `vars(key)` fills {{port}}, {{lane}}, {{entry:svc}} and
 * {{ui:key}} placeholders in the command and env. Returns { pid, port, log }.
 */
export function startDevServer(p, ui, { checkout, port, env, vars, logName }) {
  const uiDir = path.join(checkout, ui.path);
  if (!fs.existsSync(uiDir)) throw new UsageError(`UI folder not found: ${uiDir}`);
  const others = listWorktrees(p.repo).filter((w) => !w.prunable).map((w) => path.join(w.path, ui.path));
  ensureInstalled(ui, uiDir, path.join(p.repo, ui.path), others);
  ensureDir(p.paths.logs);
  const log = path.join(p.paths.logs, `${logName}.log`);
  const command = fillTemplate(ui.command, vars);
  const fullEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fillTemplate(v, vars)]));
  const pid = startDetached(command, { cwd: uiDir, env: fullEnv, logFile: log });
  return { pid, port, log, command, startedAt: new Date().toISOString() };
}

export const stopDevServer = (pid) => killTree(pid);

/** True if something listens on the port on either loopback (some dev servers bind only [::1]). */
export async function portOpen(port, timeoutMs = 800) {
  const [v4, v6] = await Promise.all([probe(port, '127.0.0.1', timeoutMs), probe(port, '::1', timeoutMs)]);
  return v4 || v6;
}

function probe(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
