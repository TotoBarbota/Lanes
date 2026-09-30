import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, matchesAny } from '../src/core/glob.mjs';
import { parseArgs } from '../src/cli/args.mjs';
import { sanitizeLaneName, parseSizeMb, deepMerge, fillTemplate } from '../src/core/util.mjs';

test('glob: patterns without a slash match the file name anywhere', () => {
  assert.ok(globMatch('pom.xml', 'pom.xml'));
  assert.ok(globMatch('a/b/pom.xml', 'pom.xml'));
  assert.ok(globMatch('docs/readme.md', '*.md'));
  assert.ok(!globMatch('docs/readme.mdx', '*.md'));
});

test('glob: patterns with a slash are anchored, ** spans folders', () => {
  assert.ok(globMatch('svc/src/test/java/A.java', '**/src/test/**'));
  assert.ok(!globMatch('svc/src/main/java/A.java', '**/src/test/**'));
  assert.ok(globMatch('.cursor/rules/x.mdc', '/.cursor/rules/x.mdc'));
  assert.ok(!globMatch('sub/.cursor/rules/x.mdc', '/.cursor/rules/x.mdc'));
  assert.ok(matchesAny('web/a.spec.ts', ['*.md', '*.spec.*']));
});

test('args: kebab-case and PascalCase options are the same option', () => {
  assert.deepEqual(parseArgs(['--no-ui', '-Include', 'a,b', 'c', '--name=x']).opts, { noui: true, include: ['a', 'b', 'c'], name: 'x' });
  assert.deepEqual(parseArgs(['-NoUi', '--include', 'a']).opts, { noui: true, include: ['a'] });
});

test('args: options that take a value consume the next argument', () => {
  const { pos, opts } = parseArgs(['snapshot', '--label', 'before-test', '--compose', 'c.yml', '--out', 'o.yml']);
  assert.deepEqual(pos, ['snapshot']);
  assert.deepEqual(opts, { label: 'before-test', compose: 'c.yml', out: 'o.yml' });
});

test('args: --ui without values means "all UIs"', () => {
  assert.deepEqual(parseArgs(['--ui']).opts.ui, []);
  assert.deepEqual(parseArgs(['--ui', 'web,admin']).opts.ui, ['web', 'admin']);
});

test('samePath sees through short names and case', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { samePath } = await import('../src/platform/index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-path-'));
  assert.ok(samePath(dir, fs.realpathSync.native(dir)));
  assert.ok(samePath(`${dir}${path.sep}`, dir));
  if (process.platform === 'win32') assert.ok(samePath(dir.toUpperCase(), dir));
  assert.ok(!samePath(dir, path.join(dir, 'x')));
});

test('lane names are derived from branch names', () => {
  assert.equal(sanitizeLaneName('fix/CART-123 total'), 'fix-cart-123-total');
  assert.equal(sanitizeLaneName('feature/a-very-long-branch-name-that-goes-on'), 'feature-a-very-long-bran');
  assert.throws(() => sanitizeLaneName('///'));
});

test('sizes, merges and templates', () => {
  assert.equal(parseSizeMb('2g'), 2048);
  assert.equal(parseSizeMb('768m'), 768);
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
  assert.equal(fillTemplate('x {{port}} {{ entry:gw }}', (k) => ({ port: 1, 'entry:gw': 'u' })[k]), 'x 1 u');
  assert.throws(() => fillTemplate('{{nope}}', () => undefined), /Unknown placeholder/);
});
