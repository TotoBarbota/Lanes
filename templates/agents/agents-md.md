## Running and testing changes (lanes)

This repository runs changes in isolated lanes on top of one shared baseline stack. At the start of any coding task, before your first edit, run `{{command}} guide` and follow what it prints. Run it again before you build, start, debug or test services, read their logs, or hand work over for testing.

- Never start the whole stack yourself, and never run `docker compose` against the project's compose files.
- If you are in the main checkout and other agents may share it, create your own worktree with `{{command}} new <task-name>` first.
