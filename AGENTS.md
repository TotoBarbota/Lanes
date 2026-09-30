# Working on lanes

Read [CONTRIBUTING.md](CONTRIBUTING.md) first; its principles apply to every change.

- Run `npm test` after every change. Add tests next to the behaviour you change (`test/*.test.mjs`,
  `node:test`, no extra dependencies).
- Code that differs per operating system goes in `src/platform/` only.
- Don't write into the user's repository. State, generated files and logs belong under `LANES_HOME`.
- Match the surrounding style: ES modules, small functions, comments only for constraints the code
  can't show.
- User-facing text (CLI output, errors, docs) is plain and specific: say what happened and what to
  run next.
- When you change options or behaviour, update the CLI help in `src/cli/main.mjs`, `docs/config.md`
  and, if agents are affected, `src/agents/guide.mjs`.
- For end-to-end checks use `lanes demo <dir>`; never test against someone's real project stack.
