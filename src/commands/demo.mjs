import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/exec.mjs';
import { UsageError } from '../core/util.mjs';
import { PACKAGE_ROOT } from '../agents/instructions.mjs';
import { log } from '../cli/context.mjs';

/** lanes demo [dir]: creates a ready-to-run example repository. */
export async function cmdDemo(p, pos) {
  const dir = path.resolve(pos[0] || 'lanes-demo');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new UsageError(`${dir} already exists and is not empty. Pass another folder: lanes demo <dir>`);
  if (!run('git', ['--version'], { allowFail: true }).ok) throw new UsageError('git is not installed or not on PATH.');
  fs.cpSync(path.join(PACKAGE_ROOT, 'examples', 'demo'), dir, { recursive: true });
  const git = (...args) => run('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  // A throwaway identity, so the demo works on machines where git has no user configured.
  git('-c', 'user.name=lanes demo', '-c', 'user.email=demo@lanes.invalid', 'commit', '-q', '-m', 'Demo shop');
  log(`Created the demo shop in ${dir}

Next:
  cd "${dir}"
  lanes doctor            # checks Docker, git and ports
  lanes baseline up       # starts the shared stack
  lanes baseline ui       # Shop page on http://localhost:3300

Then follow README.md in that folder to change a service in a lane.`);
}
