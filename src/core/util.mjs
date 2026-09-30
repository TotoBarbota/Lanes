import fs from 'node:fs';
import path from 'node:path';

export class UsageError extends Error {}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes through a temp file and a rename, so readers never see half a file. */
export function writeJson(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

export function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function sanitizeLaneName(raw) {
  const s = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  if (!s) throw new UsageError(`Cannot derive a lane name from "${raw}". Pass --name <name>.`);
  return s;
}

export function parseSizeMb(size) {
  const m = String(size).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)/);
  if (!m) return 1024;
  const v = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'g') return Math.round(v * 1024);
  if (unit === 'k') return Math.round(v / 1024);
  return Math.round(v);
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars from `over` replace those in `base`. */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** Replaces {{key}} placeholders. Unknown keys throw, so typos in lanes.yml surface immediately. */
export function fillTemplate(text, resolve) {
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, key) => {
    const v = resolve(key);
    if (v === undefined) throw new UsageError(`Unknown placeholder {{${key}}} in "${text}".`);
    return String(v);
  });
}
