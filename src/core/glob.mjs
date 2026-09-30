// Minimal glob matching for repo-relative paths with forward slashes.
// Supports **, *, ? and a leading "/" to anchor at the repo root. A pattern without a slash
// matches the file name in any folder (like .gitignore).

const cache = new Map();

function toRegex(glob) {
  let g = glob.trim();
  let anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  if (!g.includes('/')) g = `**/${g}`;
  else anchored = true;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (g.endsWith('/')) re += '.*';
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}

export function globMatch(file, glob) {
  let re = cache.get(glob);
  if (!re) {
    re = toRegex(glob);
    cache.set(glob, re);
  }
  return re.test(file);
}

export const matchesAny = (file, globs) => (globs || []).some((g) => globMatch(file, g));
