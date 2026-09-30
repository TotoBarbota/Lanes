import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureInstalled } from '../src/ui/devserver.mjs';

function checkout(root, name, files) {
  const dir = path.join(root, name, 'web');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

const ui = { install: false, installedMarker: 'node_modules/dep/index.js', reuseInstall: true, seedFromMain: [] };
const manifests = { 'package.json': '{"dependencies":{"dep":"1.0.0"}}', 'package-lock.json': '{"v":1}' };

test('dependencies are copied from a checkout with identical manifests, without its cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-ui-'));
  const donor = checkout(root, 'main', { ...manifests, 'node_modules/dep/index.js': 'x', 'node_modules/.cache/big': 'c' });
  const lane = checkout(root, 'lane', manifests);
  assert.equal(ensureInstalled(ui, lane, donor), true);
  assert.equal(fs.readFileSync(path.join(lane, 'node_modules/dep/index.js'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(lane, 'node_modules/.cache')), false);
});

test('a checkout with a different lockfile is not used as a donor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-ui-'));
  const donor = checkout(root, 'main', { ...manifests, 'package-lock.json': '{"v":2}', 'node_modules/dep/index.js': 'x' });
  const lane = checkout(root, 'lane', manifests);
  assert.equal(ensureInstalled(ui, lane, donor), false);
  assert.equal(fs.existsSync(path.join(lane, 'node_modules')), false);
  assert.equal(ensureInstalled({ ...ui, reuseInstall: false }, lane, donor), false);
});
