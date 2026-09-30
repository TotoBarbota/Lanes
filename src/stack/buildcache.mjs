import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const under = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);

/**
 * Files that can't affect `name`'s image: those inside another service's or a UI's folder,
 * unless they're also inside one of this service's or a shared folder.
 */
function isForeign(p, name, file) {
  const own = [...p.services[name].paths, ...p.shared.map((s) => s.path)];
  if (own.some((d) => under(file, d))) return false;
  const others = [
    ...Object.values(p.services).filter((s) => s.name !== name).flatMap((s) => s.paths),
    ...Object.values(p.uis).map((u) => u.path),
  ];
  return others.some((d) => under(file, d));
}

function fileStamp(abs, { content }) {
  try {
    if (content) return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    const st = fs.statSync(abs);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

/**
 * A fingerprint per service of everything in the worktree its image build can see: the commit,
 * the build definition, uncommitted files (by size and mtime) and protected files (by content,
 * because setup commands may rewrite them without changing them). Equal fingerprints mean the
 * previous image can be reused. Base images and caches outside the worktree are not covered;
 * `up --rebuild` forces a build.
 */
export function buildFingerprints(p, { worktree, head, dirty, protectedFiles, compose, keyOf }) {
  const out = {};
  for (const name of Object.keys(p.services)) {
    const def = compose.services[keyOf(name)];
    if (!def) continue;
    const h = crypto.createHash('sha1');
    h.update(`head ${head}\nbuild ${JSON.stringify(def.build)}\n`);
    for (const f of [...new Set(dirty)].sort()) {
      if (!isForeign(p, name, f)) h.update(`dirty ${f} ${fileStamp(path.join(worktree, f), { content: false })}\n`);
    }
    for (const f of [...protectedFiles].sort()) {
      if (!isForeign(p, name, f)) h.update(`protected ${f} ${fileStamp(path.join(worktree, f), { content: true })}\n`);
    }
    out[name] = h.digest('hex').slice(0, 16);
  }
  return out;
}
