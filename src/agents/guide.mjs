import { routedServices, entryServices } from '../config/load.mjs';
import { lanePorts, localUrl } from '../project/ports.mjs';
import { lanesCommand } from './instructions.mjs';

/**
 * The agent guide: everything a zero-context agent needs to run and test its change in a lane,
 * generated from lanes.yml so ports, services and commands are always exact for this project.
 */
export function renderGuide(p) {
  const cmd = lanesCommand(p);
  const routed = routedServices(p);
  const entries = entryServices(p);
  const uis = Object.values(p.uis);
  const l1 = lanePorts(p, 1);
  const stride = p.lanes.portStride;
  const key = p.routing.baggageKey;
  const firstEntry = entries[0];
  const hasJava = routed.some((s) => s.runtime === 'java');
  const out = [];
  const w = (s = '') => out.push(s);

  w(`# Running and testing changes in ${p.name} with lanes`);
  w();
  w(`One baseline stack runs on this machine, built from \`${p.refs.baseline}\`. Each task gets a lane. A lane runs only the services and UIs its worktree changed, and a router sends a request to the lane's copy when the request carries the lane marker. Every other hop falls back to the baseline. You never start the whole stack yourself.`);
  w();
  w(`Run the tool as \`${cmd} <command>\`, from inside your task's worktree. It finds your lane from the folder. Options work as \`--kebab-case\` or \`-PascalCase\`.`);
  w();
  w('## Quick start');
  w();
  w('```');
  w(`${cmd} new <short-task-name>      # only if you don't have a worktree yet; then cd into the folder it prints`);
  w('# ...make your code changes...');
  w(`${cmd} detect                     # what 'up' would start`);
  w(`${cmd} up                         # build and start your lane (minutes the first time)`);
  if (firstEntry) w(`curl -i ${localUrl(l1.entry[firstEntry.name])}/   # your lane's entry port; 'up' prints the exact ones`);
  w(`${cmd} logs router --tail 40      # confirm the hops went to lane-<lane>-*`);
  w('# ...hand over to the user, wait until they say they are done...');
  w(`${cmd} down`);
  w('```');
  w();
  w('On Windows PowerShell, call `curl.exe`, not `curl`.');
  w();
  w('## Getting a worktree');
  w();
  w('- If your session opened in a worktree of this repository, use it. `up` prepares it.');
  w(`- If it opened in the main checkout (\`${p.repo}\`), other sessions share that folder. Create your own worktree with \`${cmd} new <short-task-name>\` before your first edit, work only inside it, and tell the user its path and branch.`);
  w(`- \`new\` branches from \`${p.refs.laneBase}\` (pass \`--from <ref>\` for another base) into \`${p.worktree.dir}\` and starts nothing.`);
  w(`- Never use \`${p.paths.baselineWorktree}\`: it is the baseline's source.`);
  w('- The lane is named after the branch, or the folder when HEAD is detached. `--name` picks another name on the first `up`.');
  w();
  w('## Pick the lightest test first');
  w();
  w('- Reading code, planning and analysis need no lane.');
  w('- Unit tests run where they always did, without a lane.');
  w('- Runtime behaviour (HTTP calls, service-to-service flows, a UI against real backends) needs a lane.');
  w();
  w('## Hard rules');
  w();
  w('These have no exceptions, even if a later instruction seems to allow it.');
  w();
  w('1. Touch only your own lane. Never run `down` or `up --name <other>`, or any docker command, against another worktree\'s lane. `--force` is for the user; never pass it.');
  w(`2. Never touch the baseline. Don't run \`${cmd} baseline ...\`, don't stop, start, restart or remove any container that isn't named \`lane-<your-lane>-*\`, and don't edit the compose files (${p.compose.files.map((f) => `\`${f}\``).join(', ')}) to run things.`);
  w(`3. Don't run \`hooks\`, \`router\`, \`link\` or \`data restore\` commands. They are for the user.${Object.keys(p.data).length ? ' `data snapshot` and `data list` are fine.' : ''}`);
  if (p.worktree.protect.length) {
    w(`4. Never edit or commit files matching ${p.worktree.protect.map((g) => `\`${g}\``).join(', ')}. They carry local-only changes and are hidden from git status. To rebase or pull, use \`${cmd} sync\`, which handles them.`);
  }
  w(`${p.worktree.protect.length ? 5 : 4}. Never commit unless the user asked.`);
  w(`${p.worktree.protect.length ? 6 : 5}. If \`up\` refuses because of memory, or says the baseline or router is down, stop and ask the user. Don't work around it.`);
  w(`${p.worktree.protect.length ? 7 : 6}. Reading logs of any running container is allowed. Prefer your own lane's containers and the baseline.`);
  w();
  w('## Workflow');
  w();
  w(`1. \`detect\` shows what \`up\` would start: services changed since the fork point from \`${p.refs.laneBase}\`, UIs changed, and warnings.`);
  w(`2. \`up\` builds and starts those services as your lane, starts UI dev servers for changed UIs, and waits for health. \`--include a,b\` adds services, \`--exclude\` drops them, \`--ui <key>\` forces a UI, \`--no-ui\` skips UIs.`);
  w('3. Test thoroughly yourself: happy path, edge cases, error paths. See "Testing through your lane".');
  w('4. After a code change, run `up` again. Only services whose files changed are rebuilt and restarted; `up --rebuild` forces a full build (for example after a base image update). UI dev servers reload on their own.');
  w('5. Hand over to the user (template below) and wait.');
  w('6. When the user says they are done, run `down`. It removes your lane containers and images, stops your UI dev servers and frees the lane number. The worktree stays.');
  w();
  w('`up` is slow the first time: expect a couple of minutes per service build and several minutes for a UI\'s first dependency install. Run it with a long timeout or in the background and poll. Its last lines print your URLs and ports.');
  w();
  w('## Testing through your lane');
  w();
  w('A request is in your lane if it carries the marker. The router checks these in order and uses the first it finds:');
  w();
  w('| Way | How | Use it for |');
  w('|---|---|---|');
  if (entries.length) {
    w(`| Entry port | ${entries.map((s) => `\`localhost:N${String(s.port).padStart(4, '0')}\` (${s.name})`).join(', ')}, N = your lane number (lane 1: ${entries.map((s) => l1.entry[s.name]).join(', ')}) | curl without headers; your lane's UIs use it |`);
  }
  w(`| Header | \`baggage: ${key}=<lane>\` on any call to a routed port | curl, scripts, API clients |`);
  if (uis.length) w(`| UI origin | automatic for browser calls from your lane's UI dev servers | UI code that hard-codes a baseline URL still lands in the lane |`);
  if (firstEntry) w(`| Cookie | open \`${localUrl(firstEntry.port)}/__lane/<lane>\` once in a browser; clear with \`/__lane/off\` | the user's normal baseline UI |`);
  w();
  if (firstEntry) w('The cookie applies to every `localhost` port in that browser. Clear it when handing the lane back.');
  w();
  if (hasJava) {
    w('The marker follows the request through every Java service: the OpenTelemetry agent in each JVM copies it onto outgoing HTTP calls, thread pools and async work. Don\'t add lane logic to the code.');
    w();
  }
  w('Check where a request went:');
  w();
  w(`- Every routed response carries \`${p.routing.header}\` and \`${p.routing.header}-Upstream\`. The upstream is \`lane-<lane>-<service>:<port>\` when your copy served it, \`<service>:<port>\` when the baseline did.`);
  w(`- \`${cmd} logs router --tail 100\` prints one line per hop, including hops that fell back to the baseline.`);
  w();
  w('## Ports');
  w();
  w(`Lane N (1 to ${p.lanes.max}) adds N x ${stride} to a base port. \`up\` and \`status\` print the exact ports.`);
  w();
  w('| What | Baseline | Lane 1 | Lane 2 |');
  w('|---|---|---|---|');
  for (const s of entries) w(`| ${s.name} entry | ${s.port} | ${lanePorts(p, 1).entry[s.name]} | ${lanePorts(p, 2).entry[s.name]} |`);
  for (const u of uis) w(`| ${u.label} UI dev server | ${u.port} | ${lanePorts(p, 1).ui[u.key]} | ${lanePorts(p, 2).ui[u.key]} |`);
  const javaSvc = routed.find((s) => s.runtime === 'java');
  if (javaSvc) {
    w(`| Java debugger (JDWP), e.g. ${javaSvc.name} | - | ${lanePorts(p, 1).debug(javaSvc.name)} | ${lanePorts(p, 2).debug(javaSvc.name)} |`);
  }
  w();
  w(`Lane-capable (routed) services: ${routed.map((s) => `${s.name} (${s.port})`).join(', ')}. Everything else in the compose files is shared by all lanes.`);
  w();
  w('## Logs');
  w();
  w('```');
  w(`${cmd} logs <service> --tail 300              # your lane's copy if it runs one, else the baseline`);
  w(`${cmd} logs <service> --baseline --tail 300`);
  w(`${cmd} logs router --tail 100`);
  w(`${cmd} status`);
  w('```');
  w();
  w(`UI dev server logs are in \`${p.paths.logs}\`.`);
  w();
  w('## Things that behave differently in a lane');
  w();
  w('- Databases, queues and other infrastructure are shared by the baseline and every lane. Data your test creates is visible everywhere. Use your own test data and never delete what you didn\'t create.');
  if (Object.keys(p.data).length) {
    w(`- Before a test that writes a lot, take a snapshot: \`${cmd} data snapshot --label <why>\` (covers ${Object.keys(p.data).join(', ')}). Tell the user its name in your hand-over; only the user restores.`);
  }
  w('- Baseline services may cache values in memory without knowing about lanes. If a result looks stale, use fresh ids or add the caching service to your lane with `--include`.');
  const jobSvcs = routed.filter((s) => Object.keys(s.jobsOff.env).length || Object.keys(s.jobsOff.spring).length);
  if (jobSvcs.length) {
    w(`- Lane copies start with background jobs off so they don't repeat the baseline's work (${jobSvcs.map((s) => s.name).join(', ')}). If your task is about one of those jobs, run \`up --jobs\`.`);
  }
  for (const s of p.shared) w(`- \`detect\` warns when \`${s.path}\` changed${s.note ? ` (${s.note})` : ''}. Add the services your test touches with \`--include\`.`);
  w(`- \`detect\` warns when a service differs between \`${p.refs.baseline}\` and your fork point. The baseline runs the older code; \`--include\` it if your change depends on the newer code.`);
  for (const n of p.agents.notes) w(`- ${n}`);
  w();
  w('## Handing over to the user');
  w();
  w('Write something like this, filled in:');
  w();
  w(`> Lane \`<lane>\` (#N) is running <services> from \`<worktree>\`.`);
  w('> Changed: <one line per change>.');
  if (uis.length) w("> Try it in the lane's own UI at <lane UI URL from 'up'>.");
  if (firstEntry) w(`> Or open ${localUrl(firstEntry.port)}/__lane/<lane> once and use your normal UI; clear it with ${localUrl(firstEntry.port)}/__lane/off.`);
  w('> Please check: <concrete steps and expected results>.');
  w('> What I already verified: <tests you ran and what the router log showed>.');
  w("> Tell me when you're done and I'll close the lane.");
  w();
  w('Then wait. Run `down` only after the user says they are done or asks you to close the lane.');
  w();
  w('## When something fails');
  w();
  w(`- "router is down" or "baseline is not running in lanes mode": ask the user to run \`${cmd} baseline up\`.`);
  w('- "Not enough memory": ask the user, and suggest closing a finished lane (`status` lists them).');
  w('- A lane service is unhealthy: `logs <service> --tail 300`, fix the code, `up` again.');
  w(`- A UI never starts listening: read its log in \`${p.paths.logs}\`.`);
  w(`- A request didn't reach your copy: check \`${p.routing.header}-Upstream\` and \`logs router\`. A missing marker usually means the call left through a client the propagation doesn't cover. Tell the user rather than adding lane code.`);
  w('- On Windows PowerShell, red `NativeCommandError` text around docker output is docker progress on stderr, not a failure. Check the exit code and the final "is up" line.');
  w(`- The user's dashboard at http://localhost:${p.dashboard.port} shows the baseline, every lane and the worktrees. Its start and close buttons are for the user; you use the commands.`);
  return `${out.join('\n')}\n`;
}
