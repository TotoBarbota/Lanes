# Coding agents

lanes was built for running several coding agents at once on one machine, each on its own task,
without them stepping on each other or on you.

## Setup

Pick one of these, depending on whether your team commits agent instructions.

**Committed instructions (recommended).** Run this once and commit the result:

```sh
lanes agents --write
```

It adds a short block to `AGENTS.md` (created if missing) between `<!-- lanes:begin -->` and
`<!-- lanes:end -->`. Running it again updates the block in place. Most agent tools read
`AGENTS.md`. The block tells the agent to run `lanes guide` before its first edit.

**Local-only instructions.** If nothing about lanes may be committed, list files in
`agents.localFiles`. lanes writes them into every worktree it prepares and adds them to
`.git/info/exclude`; the pre-commit guard (`lanes hooks install`) also unstages them.

```yaml
agents:
  localFiles:
    - path: .cursor/rules/lanes.mdc
      template: cursor-rule
```

**A skill.** For agent tools that load skills from `~/.agents/skills`, set `agents.skill` (a name
and a description of when to use it) and run `lanes agents --skill` on each machine. It writes
`SKILL.md` with that machine's paths; run it again after updating lanes or the template.

**Sharing a config kept outside the repository.** Put `lanes.yml` (without `repo`), any setup
scripts and templates in their own folder or repository. Each person copies it, runs
`lanes link <path>/lanes.yml` in their checkout (which also tells lanes where the repository is),
and keeps personal settings in `lanes.local.yml` next to it.

## What agents get: `lanes guide`

The guide is generated from your `lanes.yml`, so it names your real services, ports and headers.
It covers:

- **Quick start**: `lanes up`, how long the first run takes, how to run it in the background.
- **Getting a worktree**: use the current one, or `lanes new <task>` when in the shared main
  checkout.
- **Lightest test first**: unit tests before starting anything.
- **Hard rules**: never start the whole stack or run `docker compose` on the project files; never
  touch the baseline or another agent's lane; never commit protected files; ask before `--force`.
- **Testing**: the lane's entry ports, the `baggage` header, the frontend origin and the cookie,
  with ready-to-run examples, and how to confirm with the `X-Lane` response header.
- **Ports**: entry, frontend and debugger ports for this lane.
- **Logs**: `lanes logs <service>` reads the agent's own copy first, then the baseline.
- **What behaves differently in a lane**: shared databases, jobs switched off, shared folders,
  services that differ between the baseline and the task's branch, plus your `agents.notes`.
- **Handing over**: a template with URLs and what to test, then `lanes down` once you confirm.
- **When something fails**: what to check, and when to stop and ask.

## Guard rails in the tool itself

The guide asks; the tool enforces where it can:

- Lane commands work only from inside the lane's own worktree. `lanes down --name other` from
  another worktree is refused unless a user adds `--force`.
- Baseline commands are marked as user-only in the help and the guide.
- `lanes up` refuses to start when memory would run low, and tells agents to ask the user.
- Protected files are hidden from `git status`, and the pre-commit guard unstages them.

## Suggested prompt addition

If your agent tool supports a task template, this works well:

> Work in your own lanes worktree. Test your change end to end in your lane. When it works, give
> me the URLs and steps to verify it, and wait. After I confirm, run `lanes down`.
