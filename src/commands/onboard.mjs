import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/exec.mjs';
import { UsageError, ensureDir } from '../core/util.mjs';
import { homeDir } from '../platform/index.mjs';
import { gitRepoOf, loadProject } from '../config/load.mjs';
import { draftConfig } from '../init/draft.mjs';
import { renderTemplate } from '../agents/instructions.mjs';
import { log } from '../cli/context.mjs';

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SKIP_DIRS = new Set(['node_modules', 'target', 'build', 'dist', 'out', 'vendor', 'bin', 'obj']);

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function findComposeFile(repoDir) {
  for (const dir of [repoDir, ...subdirs(repoDir)]) {
    for (const n of COMPOSE_NAMES) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  }
  return null;
}

function findPackages(repoDir, depth = 3) {
  const found = [];
  const walk = (dir, d) => {
    const f = path.join(dir, 'package.json');
    if (fs.existsSync(f)) {
      try {
        found.push({ dir: path.relative(repoDir, dir).split(path.sep).join('/') || '.', json: JSON.parse(fs.readFileSync(f, 'utf8')) });
      } catch {
        // Not valid JSON: not a UI we can drive.
      }
    }
    if (d < depth) for (const s of subdirs(dir)) walk(s, d + 1);
  };
  walk(repoDir, 0);
  return found;
}

function defaultRef(repoDir) {
  const remote = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoDir, allowFail: true });
  if (remote.ok && remote.stdout.trim()) return remote.stdout.trim();
  const local = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, allowFail: true }).stdout.trim();
  return local && local !== 'HEAD' ? local : 'main';
}

/** lanes init [--compose file] [--out file] [--force]: drafts lanes.yml from the compose stack. */
export async function cmdInit(p, pos, opts) {
  const repo = gitRepoOf(path.resolve(opts.path || process.cwd()));
  if (!repo) throw new UsageError('Run "lanes init" inside the git repository you want to use lanes with.');
  const repoDir = repo.mainCheckout || repo.top;
  const out = path.resolve(opts.out || path.join(repoDir, 'lanes.yml'));
  if (fs.existsSync(out) && !opts.force) throw new UsageError(`${out} already exists. Use --force to overwrite it, or --out <file>.`);

  const composeAbs = opts.compose ? path.resolve(opts.compose) : findComposeFile(repoDir);
  if (!composeAbs || !fs.existsSync(composeAbs)) throw new UsageError('No docker-compose.yml found in the repo root or one level below. Pass --compose <file>.');
  const cfg = run('docker', ['compose', '-f', composeAbs, 'config', '--format', 'json'], { cwd: path.dirname(composeAbs), allowFail: true });
  if (!cfg.ok) throw new UsageError(`"docker compose config" failed for ${composeAbs}:\n${cfg.stderr.trim()}`);

  const outsideRepo = path.relative(repoDir, out).startsWith('..') || path.isAbsolute(path.relative(repoDir, out));
  const draft = draftConfig({
    repoDir,
    repoLine: outsideRepo ? repoDir.split(path.sep).join('/') : null,
    composeFile: path.relative(repoDir, composeAbs).split(path.sep).join('/'),
    compose: JSON.parse(cfg.stdout),
    readText: (rel) => {
      try {
        return fs.readFileSync(path.join(repoDir, rel), 'utf8');
      } catch {
        return null;
      }
    },
    packages: findPackages(repoDir),
    ref: defaultRef(repoDir),
  });
  fs.writeFileSync(out, draft.text);
  loadProject({ configFile: out });

  log(`Wrote ${out}`);
  log(`  services : ${draft.services.map((s) => `${s.name}${s.entry ? ' (entry)' : ''}${s.java ? ' [java]' : ''}`).join(', ') || '(none)'}`);
  log(`  UIs      : ${draft.uis.map((u) => `${u.key} :${u.port}`).join(', ') || '(none)'}`);
  for (const n of draft.notes) log(`  note: ${n}`);
  log(`
Next:
  1. Review ${path.basename(out)} (ports, entry services, UI commands).
  2. lanes doctor
  3. lanes baseline up
  4. lanes agents --write     # tells coding agents how to use lanes, in AGENTS.md`);
}

const BEGIN = '<!-- lanes:begin -->';
const END = '<!-- lanes:end -->';

/** lanes agents [--write]: prints (or writes into AGENTS.md) the instructions for coding agents. */
export async function cmdAgents(p, pos, opts) {
  if (opts.skill) return writeSkill(p, opts);
  const snippet = renderTemplate(p, 'agents-md', { command: p.agents.command || 'lanes' }).trim();
  if (!opts.write) {
    process.stdout.write(`${snippet}\n`);
    return;
  }
  const top = gitRepoOf(process.cwd())?.top || p.repo;
  const file = path.join(top, 'AGENTS.md');
  const block = `${BEGIN}\n${snippet}\n${END}`;
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = cur.indexOf(BEGIN);
  const end = cur.indexOf(END);
  let next;
  if (start >= 0 && end > start) next = `${cur.slice(0, start)}${block}${cur.slice(end + END.length)}`;
  else next = cur ? `${cur.replace(/\s*$/, '')}\n\n${block}\n` : `# Agent instructions\n\n${block}\n`;
  fs.writeFileSync(file, next);
  log(`${cur ? 'Updated' : 'Created'} ${file}. Commit it so every agent session sees it.`);
}

/** Writes the agent skill (agents.skill in lanes.yml) into the user's skills folder, with this machine's paths. */
function writeSkill(p, opts) {
  const skill = p.agents.skill;
  if (!skill) throw new UsageError('No agents.skill in lanes.yml. Add one with a name and a description (see docs/agents.md).');
  const dir = path.resolve(opts.dir || path.join(homeDir(), '.agents', 'skills'), skill.name);
  const file = path.join(dir, 'SKILL.md');
  const text = renderTemplate(p, skill.template, { skillName: skill.name, skillDescription: skill.description });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (cur === text) {
    log(`${file} is already current.`);
    return;
  }
  ensureDir(dir);
  fs.writeFileSync(file, text);
  log(`${cur === null ? 'Created' : 'Updated'} ${file}.`);
}
