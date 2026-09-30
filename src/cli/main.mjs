import { parseArgs } from './args.mjs';
import { UsageError } from '../core/util.mjs';
import { loadProject } from '../config/load.mjs';
import { cmdDetect, cmdUp, cmdDown, cmdStatus, cmdLogs, cmdNew, cmdSync } from '../commands/lane.mjs';
import { cmdBaseline } from '../commands/baseline.mjs';
import { cmdSetup, cmdHooks, cmdRouter, cmdLink, cmdDashboard, cmdDoctor } from '../commands/admin.mjs';
import { renderGuide } from '../agents/guide.mjs';
import { cmdDemo } from '../commands/demo.mjs';
import { cmdInit, cmdAgents } from '../commands/onboard.mjs';
import { cmdData } from '../commands/data.mjs';

const HELP = `lanes - run many tasks side by side on one shared Docker Compose stack

Getting started:
  lanes demo [dir]           Create a small example repository to try lanes on.
  lanes init [--compose f] [--out f] [--force]
                             Draft lanes.yml for this repository from its compose file.
  lanes agents [--write]     Print (or add to AGENTS.md) the instructions for coding agents.
  lanes agents --skill [--dir d]
                             Install the agent skill from lanes.yml (agents.skill) into
                             ~/.agents/skills (or d), with this machine's paths.

Lane commands (run from inside the task's worktree):
  lanes up [--name n] [--include a,b] [--exclude a,b] [--ui [key,..]] [--no-ui]
           [--jobs] [--no-build | --rebuild] [--no-wait] [--force]
                             Detect changed services, build and start them as this worktree's lane.
                             Re-run after code changes: only services whose inputs changed are
                             rebuilt. --rebuild builds all of them regardless.
  lanes down [--name n]      Stop this worktree's lane containers and UI dev servers, free the lane.
  lanes status [--json]      Baseline, router, lanes, memory.
  lanes detect               Dry run: what 'up' would start, plus baseline differences.
  lanes logs <service|router> [--lane n | --baseline] [--tail 200] [--follow]
  lanes new <branch> [--name n] [--from <ref>]
                             Create a prepared worktree (starts nothing).
  lanes sync [--onto <ref>]  Rebase or pull this worktree, handling protected files.
  lanes setup on|off|status  Run or undo the worktree setup from lanes.yml.
  lanes data snapshot [--label x] | list
                             Save or list snapshots of the shared data stores (lanes.yml "data").
  lanes guide                Print the agent guide for this project.

User commands (agents must not run these):
  lanes baseline up [--heavy] [--no-build] | down [--force] | refresh | status
  lanes baseline pause <svc> | resume <svc> | ui [key] [--stop]
  lanes data restore <snapshot> --yes
                             Overwrite the shared data stores with a snapshot.
  lanes hooks install | uninstall | status
  lanes router               Regenerate and reload the router config.
  lanes dashboard [stop]     Web dashboard: state, logs, and buttons to start, update and close lanes.
  lanes link <lanes.yml>     Use a lanes.yml kept outside this repository.
  lanes doctor

Global: --config <lanes.yml> (or LANES_CONFIG) picks the project config explicitly.
`;

const COMMANDS = {
  up: cmdUp,
  down: cmdDown,
  status: cmdStatus,
  detect: cmdDetect,
  logs: cmdLogs,
  new: cmdNew,
  sync: cmdSync,
  setup: cmdSetup,
  baseline: cmdBaseline,
  hooks: cmdHooks,
  router: cmdRouter,
  dashboard: cmdDashboard,
  doctor: cmdDoctor,
  guide: async (p) => process.stdout.write(renderGuide(p)),
  agents: cmdAgents,
  data: cmdData,
};

export async function main(argv) {
  // Default provenance attestations give every build a new image digest, which makes compose
  // recreate lane containers whose code did not change.
  process.env.BUILDX_NO_DEFAULT_ATTESTATIONS ||= '1';
  const [cmdRaw, ...rest] = argv;
  const cmd = (cmdRaw || 'help').toLowerCase();
  const { pos, opts } = parseArgs(rest);
  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
      console.log(HELP);
      return;
    }
    const noProject = { link: cmdLink, demo: cmdDemo, init: cmdInit };
    if (noProject[cmd]) {
      await noProject[cmd](null, pos, opts);
      return;
    }
    const fn = COMMANDS[cmd];
    if (!fn) throw new UsageError(`Unknown command "${cmdRaw}". Run "lanes help".`);
    const p = loadProject({ cwd: opts.path || process.cwd(), configFile: opts.config });
    await fn(p, pos, opts);
  } catch (e) {
    console.error(e instanceof UsageError ? `lanes: ${e.message}` : `lanes: ${e.stack || e.message}`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
