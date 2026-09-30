// Options accept --kebab-case and PowerShell-style -PascalCase, case-insensitively:
// --no-ui, -NoUi and -noui are the same option.

const LIST_OPTS = new Set(['include', 'exclude', 'ui']);
const VALUE_OPTS = new Set(['name', 'tail', 'onto', 'lane', 'from', 'path', 'config', 'port', 'compose', 'out', 'label', 'dir']);

const isFlag = (a) => /^--?[A-Za-z]/.test(a);

export function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!isFlag(a)) {
      pos.push(a);
      continue;
    }
    let key = a.replace(/^--?/, '');
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    key = key.toLowerCase().replace(/-/g, '');
    if (LIST_OPTS.has(key)) {
      const vals = val !== undefined ? [val] : [];
      while (val === undefined && i + 1 < argv.length && !isFlag(argv[i + 1])) vals.push(argv[++i]);
      opts[key] = (opts[key] || []).concat(vals.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean));
    } else if (VALUE_OPTS.has(key)) {
      opts[key] = val ?? argv[++i];
    } else {
      opts[key] = val ?? true;
    }
  }
  return { pos, opts };
}
