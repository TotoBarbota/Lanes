import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftConfig } from '../src/init/draft.mjs';
import { loadProject } from '../src/config/load.mjs';

process.env.LANES_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-test-'));

test('init drafts services, entry points, Java runtimes and UIs from a compose stack', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-init-'));
  const abs = (p) => path.join(repoDir, p);
  const compose = {
    name: 'shop',
    services: {
      gateway: { build: { context: abs('gateway'), dockerfile: 'Dockerfile' }, ports: [{ target: 8080, published: '8080' }], environment: { ORDERS_URL: 'http://orders:8081/api' } },
      orders: { build: { context: repoDir, dockerfile: 'services/orders/Dockerfile' }, expose: ['8081'] },
      admin: { build: { context: abs('admin'), dockerfile: 'Dockerfile' }, ports: [{ target: 9000, published: '9000' }], environment: { GATEWAY: 'http://gateway:8080' } },
      worker: { build: { context: abs('worker') } },
      postgres: { image: 'postgres:16', ports: [{ target: 5432, published: '5432' }] },
      'web-ui': { build: { context: abs('web') }, ports: [{ target: 5173, published: '5173' }] },
    },
  };
  const files = {
    'gateway/Dockerfile': 'FROM eclipse-temurin:21-jre\nCOPY target/app.jar /app.jar',
    'services/orders/Dockerfile': 'FROM node:20',
    'admin/Dockerfile': 'FROM python:3.12',
    'web/.env.development': 'VITE_API_URL=http://localhost:8080\nVITE_ADMIN=http://localhost:9000/x\n',
  };
  const draft = draftConfig({
    repoDir,
    repoLine: repoDir.split(path.sep).join('/'),
    composeFile: 'docker-compose.yml',
    compose,
    readText: (rel) => files[rel] ?? null,
    packages: [{ dir: 'web', json: { scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } } }],
    ref: 'origin/main',
  });

  const byName = Object.fromEntries(draft.services.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['admin', 'gateway', 'orders']);
  assert.equal(byName.gateway.java, true);
  assert.equal(byName.orders.java, false);
  assert.equal(byName.gateway.entry, true, 'called by the UI env file, although admin calls it too');
  assert.equal(byName.admin.entry, true, 'published and called by nobody');
  assert.equal(byName.orders.entry, false);
  assert.deepEqual(byName.orders.paths, ['services/orders']);
  assert.match(draft.text, /exclude: \[web-ui\]/);
  assert.match(draft.text, /# worker: has a build section but no port/);
  assert.match(draft.text, /command: "npm run dev -- --port \{\{port\}\} --strictPort"/);
  assert.match(draft.text, /VITE_API_URL: "\{\{entry:gateway\}\}"/);
  assert.match(draft.text, /VITE_ADMIN: "\{\{entry:admin\}\}"/);

  const file = path.join(repoDir, 'lanes.yml');
  fs.writeFileSync(file, draft.text);
  const p = loadProject({ configFile: file });
  assert.equal(p.services.gateway.runtime, 'java');
  assert.equal(p.uis.web.port, 5173);
  assert.deepEqual(p.compose.exclude, ['web-ui']);
});
