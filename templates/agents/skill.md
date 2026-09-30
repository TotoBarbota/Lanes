---
name: {{skillName}}
description: {{skillDescription}}
---

# {{skillName}}

Changes to `{{repo}}` run in lanes: one shared baseline stack on this machine, and per task only the changed services and UIs, reached by request header. The tool is lanes; it is not part of the repository.

Before your first edit, and again before you build, start, debug or test anything, read logs, or hand work to the user, run this from your task's worktree and follow everything it prints:

```
{{command}} guide
```

The guide is generated from the project config, so its ports, services, commands and rules are always current. Its hard rules have no exceptions. In short:

- Work only in your own worktree and lane. Never touch the baseline or another lane, and never pass `--force`.
- Never commit unless the user asked, and never commit lanes files or config.
- Test thoroughly yourself, then ask the user to test. Run `down` only after the user says they are done.
