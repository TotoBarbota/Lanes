import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillTemplate, UsageError } from '../core/util.mjs';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LANES_BIN = path.join(PACKAGE_ROOT, 'bin', 'lanes.mjs');
const TEMPLATES = path.join(PACKAGE_ROOT, 'templates', 'agents');

/**
 * The command agents should type. Defaults to node plus this installation's absolute entry point,
 * which works from any shell and can't pick up a different `lanes` on PATH. agents.command overrides it.
 */
export function lanesCommand(p) {
  return p?.agents?.command || `node "${LANES_BIN}"`;
}

function templateText(p, name) {
  const builtin = path.join(TEMPLATES, `${name}.md`);
  if (fs.existsSync(builtin)) return fs.readFileSync(builtin, 'utf8');
  const custom = path.resolve(p.configDir, name);
  if (fs.existsSync(custom)) return fs.readFileSync(custom, 'utf8');
  throw new UsageError(`agents.localFiles: template "${name}" is neither built in (${fs.readdirSync(TEMPLATES).join(', ')}) nor a file next to lanes.yml.`);
}

export function renderTemplate(p, name, overrides = {}) {
  const vars = { project: p.name, repo: p.repo, configDir: p.configDir, command: lanesCommand(p), ...overrides };
  return fillTemplate(templateText(p, name), (k) => vars[k]);
}

export function renderLocalFile(p, file) {
  return renderTemplate(p, file.template ?? 'cursor-rule');
}
