import fs from 'node:fs';
import path from 'node:path';
import { run, runAsync, lines } from '../core/exec.mjs';
import { UsageError } from '../core/util.mjs';
import { matchesAny } from '../core/glob.mjs';
import { samePath } from '../platform/index.mjs';
import { routedServices } from '../config/load.mjs';

export function worktreeInfo(dir) {
  // --abbrev-ref applies to every revision after it, so the full HEAD must come first.
  const r = run('git', ['rev-parse', '--show-toplevel', '--git-common-dir', 'HEAD', '--abbrev-ref', 'HEAD'], { cwd: dir, allowFail: true });
  if (!r.ok) throw new UsageError(`${dir} is not inside a git worktree with at least one commit.`);
  const [topRaw, commonRaw, sha, ref] = r.stdout.trim().split(/\r?\n/);
  const top = path.normalize(topRaw);
  return { top, common: path.resolve(top, commonRaw), branch: ref === 'HEAD' ? '' : ref, head: sha.slice(0, 9), sha };
}

export function assertProjectWorktree(wt, p) {
  if (!samePath(wt.common, path.join(p.repo, '.git'))) {
    throw new UsageError(`${wt.top} is not a worktree of ${p.repo} (project "${p.name}").`);
  }
}

export function fetchRefs(repo, refs) {
  const remoteBranches = [...new Set(refs.filter((r) => r.startsWith('origin/')).map((r) => r.slice('origin/'.length)))];
  if (!remoteBranches.length) return { ok: true };
  const r = run('git', ['fetch', 'origin', ...remoteBranches], { cwd: repo, allowFail: true });
  return { ok: r.ok, message: (r.stderr || '').trim().split(/\r?\n/).slice(-1)[0] };
}

const under = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);

/** Maps changed files to the lane-runnable services, UIs and shared folders they belong to. */
export function classifyChanges(p, files) {
  const routed = routedServices(p);
  const services = new Set();
  const uis = new Set();
  const shared = new Map();
  const other = new Set();
  const ignore = [...p.detect.ignore, ...p.worktree.protect];
  for (const f of files) {
    if (matchesAny(f, ignore)) continue;
    const svc = routed.find((s) => s.paths.some((d) => under(f, d)));
    if (svc) {
      services.add(svc.name);
      continue;
    }
    const ui = Object.values(p.uis).find((u) => under(f, u.path));
    if (ui) {
      uis.add(ui.key);
      continue;
    }
    const sh = p.shared.find((s) => under(f, s.path));
    if (sh) {
      shared.set(sh.path, sh);
      continue;
    }
    other.add(f.split('/')[0]);
  }
  return { services: [...services].sort(), uis: [...uis].sort(), shared: [...shared.values()], other: [...other].sort() };
}

/** Paths from `git status --porcelain -z`, including both sides of renames and copies. */
export function parseStatusZ(out) {
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    files.push(rec.slice(3));
    if (rec[0] === 'R' || rec[0] === 'C') files.push(parts[++i]);
  }
  return files;
}

/**
 * What a lane must run: services and UIs changed in this worktree since its fork point from
 * refs.laneBase, counting commits, uncommitted edits and untracked files. `gap` lists routed
 * services whose code differs between the baseline and that fork point.
 */
export async function detectChanges(wtTop, p) {
  // `git status` uses the untracked cache and fsmonitor when enabled; `ls-files --others` does not.
  const statusP = runAsync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: wtTop });
  const mb = (await runAsync('git', ['merge-base', 'HEAD', p.refs.laneBase], { cwd: wtTop, allowFail: true })).stdout.trim();
  const base = mb || p.refs.laneBase;
  const [status, committed, gap] = await Promise.all([
    statusP,
    runAsync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: wtTop }),
    runAsync('git', ['diff', '--name-only', p.refs.baseline, base], { cwd: wtTop, allowFail: true }),
  ]);
  const dirty = parseStatusZ(status.stdout);
  const files = new Set([...lines(committed.stdout), ...dirty]);
  return {
    base,
    dirty,
    ...classifyChanges(p, files),
    changedCount: files.size,
    gap: gap.ok ? classifyChanges(p, lines(gap.stdout)).services : [],
  };
}

export function ensureBaselineWorktree(p) {
  const dir = p.paths.baselineWorktree;
  if (fs.existsSync(path.join(dir, '.git'))) return false;
  run('git', ['worktree', 'add', '--detach', dir, p.refs.baseline], { cwd: p.repo });
  return true;
}

export function listWorktrees(repo, runner = run) {
  const parse = (r) => {
    if (!r.ok) return [];
    const out = [];
    let cur = null;
    for (const l of r.stdout.split(/\r?\n/)) {
      if (l.startsWith('worktree ')) {
        cur = { path: path.normalize(l.slice(9)) };
        out.push(cur);
      } else if (!cur) continue;
      else if (l.startsWith('HEAD ')) cur.head = l.slice(5, 14);
      else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace('refs/heads/', '');
      else if (l === 'detached') cur.detached = true;
      else if (l.startsWith('prunable')) cur.prunable = true;
    }
    return out;
  };
  const r = runner('git', ['worktree', 'list', '--porcelain'], { cwd: repo, allowFail: true });
  return typeof r?.then === 'function' ? r.then(parse) : parse(r);
}
