# Contributing

Thanks for helping. Bug reports with `lanes doctor` output (and `LANES_TIMING=1` output for
performance issues) are the most useful thing you can send.

## Development setup

```sh
git clone https://github.com/TotoBarbota/Lanes.git lanes
cd lanes
npm install
npm link          # puts `lanes` on your PATH, pointing at this checkout
npm test
```

Node.js 20+, no build step. The only runtime dependency is `yaml`.

To try changes end to end, use the demo: `lanes demo /tmp/lanes-demo`, then follow its README.
It exercises the baseline, a Java lane, header propagation, a frontend lane and the dashboard in a
few minutes.

## Layout

| Folder | Contents |
|---|---|
| `bin/` | CLI entry point. |
| `src/cli/` | Argument parsing, help, shared command helpers. |
| `src/commands/` | One module per command group. |
| `src/config/` | `lanes.yml` discovery, validation and defaults. |
| `src/git/` | Worktrees, change detection, protected files, hooks. |
| `src/stack/` | Generated compose files for the baseline and lanes, build fingerprints. |
| `src/router/` | nginx config generation and reloads. |
| `src/runtimes/` | Runtime support (Java: OpenTelemetry agent, heap, debugger). |
| `src/docker/` | Docker Engine API client with CLI fallback. |
| `src/ui/` | Frontend dev servers and dependency installs. |
| `src/platform/` | Everything that differs between operating systems. |
| `src/init/` | `lanes init` config drafting. |
| `dashboard/` | Read-only web dashboard. |
| `templates/agents/` | Agent instruction templates. |
| `examples/demo/` | The project `lanes demo` creates. |
| `test/` | `node:test` suites and fixtures. |

## Principles

- **Portable core.** Only `src/platform/` may branch on `process.platform` or call OS-specific
  tools. Windows is the tested platform today; Linux and macOS must keep working by design.
- **Nothing in the user's repository.** Generated files, state and logs go under `LANES_HOME`.
  The only things lanes writes into a checkout are what the user configured (`worktree.setup`,
  `agents.localFiles`) and `AGENTS.md` when asked to.
- **Never touch what isn't yours.** Lane commands act on the current worktree's lane only. Anything
  that affects the baseline or other lanes is a user command.
- **Fast by default.** Prefer the Docker Engine API over CLI calls, batch git calls, and skip work
  whose inputs didn't change. Measure with `LANES_TIMING=1`.
- **Errors say what to do.** A message should name the key, file or command involved and the fix.

## Pull requests

- Add or update tests for behaviour changes (`npm test` must pass).
- Update `docs/` and the CLI help when you change options or behaviour.
- Keep commits focused; describe the user-visible effect in the message.
