import fs from 'node:fs';
import path from 'node:path';
import { run, runShell, lines } from '../core/exec.mjs';
import { UsageError, readJson, writeJson, ensureDir, fillTemplate } from '../core/util.mjs';
import { matchesAny } from '../core/glob.mjs';
import { toPortablePath, samePath } from '../platform/index.mjs';
import { renderLocalFile } from '../agents/instructions.mjs';

// ---------------------------------------------------------------- protected files

function sparseEnabled(dir) {
  return run('git', ['config', '--bool', 'core.sparseCheckout'], { cwd: dir, allowFail: true }).stdout.trim() === 'true';
}

/** Tracked files matching worktree.protect, with their git flags (S = skip-worktree, lower case = assume-unchanged). */
function protectedEntries(p, dir) {
  if (!p.worktree.protect.length) return [];
  const out = run('git', ['ls-files', '-v'], { cwd: dir }).stdout;
  return lines(out)
    .map((l) => ({ flag: l[0], file: l.slice(2) }))
    .filter((e) => matchesAny(e.file, p.worktree.protect));
}

const isMarked = (e) => e.flag === 'S' || (e.flag >= 'a' && e.flag <= 'z');

/**
 * Hides local edits to protected files from git status, so they are never staged by accident.
 * Sparse checkouts own the skip-worktree bit, so there assume-unchanged is used instead.
 */
export function protectFiles(p, dir) {
  const entries = protectedEntries(p, dir);
  if (!entries.length) return { marked: 0, total: 0, files: [] };
  const modified = new Set(lines(run('git', ['diff', '--name-only'], { cwd: dir }).stdout));
  const toMark = entries.filter((e) => !isMarked(e) && modified.has(e.file)).map((e) => e.file);
  const flag = sparseEnabled(dir) ? '--assume-unchanged' : '--skip-worktree';
  if (toMark.length) run('git', ['update-index', flag, '--', ...toMark], { cwd: dir });
  return { marked: entries.filter(isMarked).length + toMark.length, total: entries.length, flag, files: entries.map((e) => e.file) };
}

export function unprotectFiles(p, dir) {
  const marked = protectedEntries(p, dir).filter(isMarked).map((e) => e.file);
  if (marked.length) run('git', ['update-index', '--no-skip-worktree', '--no-assume-unchanged', '--', ...marked], { cwd: dir });
  return marked.length;
}

/** exposed = protected files with local edits that git status would still show (and could stage). */
export function protectionStatus(p, dir) {
  const entries = protectedEntries(p, dir);
  const modified = new Set(lines(run('git', ['diff', '--name-only'], { cwd: dir }).stdout));
  const exposed = entries.filter((e) => !isMarked(e) && modified.has(e.file)).map((e) => e.file);
  return { total: entries.length, marked: entries.filter(isMarked).length, exposed };
}

// ---------------------------------------------------------------- worktree setup / teardown

function worktreeCommand(p, which, dir) {
  const cmd = p.worktree[which];
  if (!cmd) return 0;
  const text = fillTemplate(cmd, (k) => ({ configDir: p.configDir, repo: p.repo, worktree: dir })[k]);
  const code = runShell(text, { cwd: dir });
  if (code !== 0) throw new UsageError(`worktree.${which} failed in ${dir} (exit ${code}): ${text}`);
  return 1;
}

/** Makes a worktree ready to run: project setup command, protected files hidden, local agent files. */
export function prepareWorktree(p, dir) {
  worktreeCommand(p, 'setup', dir);
  const prot = protectFiles(p, dir);
  const files = writeLocalAgentFiles(p, dir);
  return { protect: prot, agentFiles: files };
}

/** Undoes prepareWorktree's git-visible effects, e.g. before a rebase. */
export function teardownWorktree(p, dir) {
  const cleared = unprotectFiles(p, dir);
  worktreeCommand(p, 'teardown', dir);
  return { cleared };
}

export function applySparse(p, dir) {
  if (!p.worktree.sparse?.length) return false;
  run('git', ['sparse-checkout', 'set', '--no-cone', '--stdin'], { cwd: dir, input: `${p.worktree.sparse.join('\n')}\n` });
  return true;
}

// ---------------------------------------------------------------- local agent files

function excludeFileOf(dir) {
  const common = path.resolve(dir, run('git', ['rev-parse', '--git-common-dir'], { cwd: dir }).stdout.trim());
  return path.join(common, 'info', 'exclude');
}

/**
 * Writes agents.localFiles into a checkout. They are listed in the repo's shared info/exclude
 * (which covers every worktree), so git never offers them for a commit.
 */
export function writeLocalAgentFiles(p, dir) {
  if (!p.agents.localFiles.length) return 0;
  const excludeFile = excludeFileOf(dir);
  const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
  const have = new Set(current.split(/\r?\n/));
  const add = p.agents.localFiles.map((f) => `/${f.path}`).filter((e) => !have.has(e));
  if (add.length) {
    ensureDir(path.dirname(excludeFile));
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludeFile, `${sep}# lanes: local agent instructions, never committed\n${add.join('\n')}\n`);
  }
  let written = 0;
  for (const f of p.agents.localFiles) {
    const target = path.join(dir, f.path);
    const wanted = renderLocalFile(p, f, dir);
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === wanted) continue;
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, wanted);
    written++;
  }
  return written;
}

// ---------------------------------------------------------------- git hooks

const HOOK_NAMES = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'post-rewrite',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'fsmonitor-watchman', 'post-index-change',
];
const OWN_HOOKS = new Set(['pre-commit']);

function hookScript(name, lanesBin, previous) {
  const own = OWN_HOOKS.has(name)
    ? `node "${lanesBin}" hooks run ${name} "$@" || exit $?\n`
    : '';
  const prev = previous ? toPortablePath(previous) : '';
  return `#!/bin/sh
# Generated by lanes. Enabled through core.hooksPath in this repo's local .git/config only.
${own}prev="${prev}"
if [ -n "$prev" ]; then
  case "$prev" in /*|?:*) dir="$prev" ;; *) dir="$(git rev-parse --show-toplevel)/$prev" ;; esac
else
  dir="$(git rev-parse --git-common-dir)/hooks"
fi
if [ -x "$dir/${name}" ]; then exec "$dir/${name}" "$@"; fi
exit 0
`;
}

const hooksStateFile = (p) => path.join(p.paths.state, 'hooks.json');

export function hooksStatus(p) {
  const cur = run('git', ['config', '--get', 'core.hooksPath'], { cwd: p.repo, allowFail: true }).stdout.trim();
  return { current: cur || null, active: !!cur && samePath(cur, p.paths.hooks), previous: readJson(hooksStateFile(p), {}).previous ?? null };
}

export function installHooks(p, lanesBin) {
  const st = hooksStatus(p);
  const previous = st.active ? st.previous : st.current;
  ensureDir(p.paths.hooks);
  for (const name of HOOK_NAMES) {
    const file = path.join(p.paths.hooks, name);
    fs.writeFileSync(file, hookScript(name, toPortablePath(lanesBin), previous));
    fs.chmodSync(file, 0o755);
  }
  writeJson(hooksStateFile(p), { previous });
  run('git', ['config', 'core.hooksPath', toPortablePath(p.paths.hooks)], { cwd: p.repo });
  return { previous };
}

export function uninstallHooks(p) {
  const st = hooksStatus(p);
  if (!st.active) return { restored: false };
  if (st.previous) run('git', ['config', 'core.hooksPath', st.previous], { cwd: p.repo });
  else run('git', ['config', '--unset', 'core.hooksPath'], { cwd: p.repo, allowFail: true });
  fs.rmSync(hooksStateFile(p), { force: true });
  return { restored: true, previous: st.previous };
}

/** pre-commit: unstage protected files and local agent files, then let the commit continue. */
export function runPreCommit(p, dir) {
  const guarded = [...p.worktree.protect, ...p.agents.localFiles.map((f) => `/${f.path}`)];
  if (!guarded.length) return 0;
  const staged = () => lines(run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], { cwd: dir }).stdout)
    .filter((f) => matchesAny(f, guarded));
  const hit = staged();
  if (hit.length) {
    run('git', ['reset', '-q', 'HEAD', '--', ...hit], { cwd: dir, allowFail: true });
    console.log('lanes: unstaged files that are never committed from this machine:');
    for (const f of hit) console.log(`  - ${f}`);
  }
  const still = staged();
  if (still.length) {
    console.log(`lanes: could not unstage ${still.join(', ')}; commit aborted.`);
    return 1;
  }
  return 0;
}
