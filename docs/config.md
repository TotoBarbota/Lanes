# lanes.yml reference

`lanes init` drafts this file for you. lanes looks for it in this order:

1. `--config <file>` or the `LANES_CONFIG` environment variable.
2. `lanes.yml`, `lanes.yaml` or `.lanes/lanes.yml` in the current worktree, then in the main checkout.
3. A file linked with `lanes link <file>` (for configs kept outside the repository).

Paths in the file are relative to the repository root unless noted. Errors name the exact key and
what's expected, for example `lanes.yml: "services.api.port" must be the container port...`.

**Personal overrides.** A `lanes.local.yml` next to `lanes.yml` is merged on top of it, key by key
(lists are replaced, not merged). Use it for settings that differ per person, such as
`worktree.dir`, `dashboard.port`, heap sizes or memory limits, so the shared file stays the same for
everyone. Keep it out of version control. `lanes doctor` shows when one is active.

## Minimal example

```yaml
name: shop
refs:
  baseline: origin/main
  laneBase: origin/main
services:
  gateway: { port: 8080, entry: true, runtime: java }
  orders:  { port: 8081, runtime: java }
```

## Top level

| Key | Default | Meaning |
|---|---|---|
| `name` | required | Short id (lower-case letters, digits, dashes). Names containers, images and the state folder `~/.lanes/projects/<name>`. |
| `repo` | the config's own repository, else the repository linked to it | Path to the repository. Needed only when `lanes.yml` lives outside it and isn't attached with `lanes link`. Always resolved to the main checkout. |
| `refs.baseline` | required | Ref the baseline stack runs, e.g. `origin/main`. `lanes baseline refresh` fetches and moves to its latest commit. |
| `refs.laneBase` | required | Ref task branches start from. Change detection compares against the fork point with it. |

## compose

| Key | Default | Meaning |
|---|---|---|
| `files` | `[docker-compose.yml]` | Compose files, in `-f` order. |
| `project` | `name` | Compose project name of the baseline. Use the name your stack already runs under to keep its volumes. |
| `exclude` | `[]` | Services the baseline doesn't start, e.g. frontends that lanes runs as dev servers instead. |
| `overrides` | `{}` | Per-service settings merged into the generated baseline compose (maps merge, lists replace). Handy for smaller database caches in development. |

```yaml
compose:
  files: [docker/docker-compose.yml]
  project: docker
  exclude: [web-ui]
  overrides:
    mongodb:
      command: ["--wiredTigerCacheSizeGB", "1"]
```

## services

One entry per service that lanes can run a lane copy of. The key is the compose service name.
Services you don't list (databases, brokers, third-party images) are shared by every lane as they
are.

| Key | Default | Meaning |
|---|---|---|
| `port` | required unless `route: false` | Container port the service listens on. The router takes over this host port. |
| `entry` | `false` | Called from outside the stack (browser, API client). Gets a per-lane entry port and the cookie switch pages `/__lane/<name>` and `/__lane/off`. |
| `runtime` | `none` | `java` attaches the OpenTelemetry agent (header propagation), sets heap and memory limits and opens a debugger port in lanes. `none` leaves the process alone. |
| `paths` | `[<service name>]` | Folders whose changes mean this service must run in the lane. |
| `route` | `true` | `false` for services that are only configured (heap, jobs) but not routed per lane. |
| `laneEnv` | `{}` | Extra environment for lane copies only. |
| `jobsOff.env` | `{}` | Environment that disables background jobs in lane copies (schedulers, consumers). Applied unless `lanes up --jobs`. |
| `jobsOff.spring` | `{}` | Same, as Spring properties. Merged into `SPRING_APPLICATION_JSON`. |
| `jobsNote` | none | Shown to agents in the guide, e.g. which jobs are turned off. |
| `heap.baseline`, `heap.lane` | from `runtimes.java.heap` | Java max heap for this service. |
| `cors` | none | See below. |

### cors

Browsers on a lane frontend's port need to be allowed by entry services that check CORS. lanes can
add every lane frontend origin to the service's allowed list:

| Key | Meaning |
|---|---|
| `uis` | Frontend keys whose lane origins to allow. |
| `springProperty` | Spring property holding a comma-separated origin list, set through `SPRING_APPLICATION_JSON`. |
| `env` | Or: environment variable holding the list. |
| `from` | Environment variables to read the existing list from (first one set wins). |
| `default` | Existing list when none of `from` is set. |

```yaml
services:
  gateway:
    port: 8080
    entry: true
    cors:
      uis: [web]
      env: CORS_ALLOWED_ORIGINS
      from: [CORS_ALLOWED_ORIGINS]
      default: http://localhost:3000
```

## uis

Frontends run as dev servers on the host, one per lane, so they hot-reload from the lane's
worktree. The key names the frontend in commands (`lanes up --ui web`, `lanes baseline ui web`).

| Key | Default | Meaning |
|---|---|---|
| `path` | required | Folder of the frontend. |
| `port` | required | Port of the baseline copy. Lane *N* uses `port + N × stride`. |
| `command` | required | Dev server command, run in `path`. Placeholders below. |
| `label` | the key | Display name. |
| `env` | `{}` | Environment for every copy. |
| `laneEnv` | `{}` | Environment for lane copies only, typically API URLs: `API_URL: "{{entry:gateway}}"`. |
| `install` | `auto` | Command that installs dependencies on first start. `auto` runs `npm ci` when a lockfile is tracked, else `npm install`. `false` skips it. |
| `installedMarker` | `node_modules` | Path whose existence means "installed". |
| `reuseInstall` | `true` | Copy `node_modules` from another checkout with identical `package.json` and lockfile instead of installing (about a minute instead of several). |
| `seedFromMain` | `[]` | Untracked files (such as a gitignored lockfile) to copy from the main checkout when `package.json` is identical. |
| `memoryGb` | `2` | Memory a dev server needs, for the memory check. |

Placeholders in `command`, `env` and `laneEnv`:

| Placeholder | Value |
|---|---|
| `{{port}}` | This copy's port. |
| `{{lane}}` | Lane name (empty for the baseline). |
| `{{entry:<service>}}` | URL of the service's entry port for this lane (baseline port for the baseline copy). |
| `{{ui:<key>}}` | URL of another frontend in the same lane, or its baseline copy if the lane doesn't run it. |

## shared

Folders used by several services, such as a common library. Changes there don't start anything by
themselves; lanes warns and asks you to `--include` the services your test needs.

```yaml
shared:
  - path: libs/common
    note: used by every Java service
```

## data

Shared data stores that `lanes data snapshot` saves and `lanes data restore` puts back, so a test
that writes a lot can be undone. The key is the compose service. Both commands run inside that
service's baseline container with `sh -c`, so they can use its environment variables. `dump` must
write the backup to stdout; `restore` reads it from stdin.

| Key | Meaning |
|---|---|
| `dump` | Command that writes a full backup to stdout. |
| `restore` | Command that restores a backup read from stdin. |
| `ext` | File extension for the saved backup (default `dump`). |

```yaml
data:
  mongodb:
    ext: archive.gz
    dump: mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --gzip --archive
    restore: mongorestore -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --gzip --archive --drop --nsExclude='admin.*'
  postgres:
    ext: sql
    dump: pg_dumpall -U "$POSTGRES_USER" --clean
    restore: psql -U "$POSTGRES_USER" -d postgres
```

Snapshots are kept in `~/.lanes/projects/<name>/snapshots`. Agents may take snapshots; only
users restore (`--yes` is required, because a restore affects the baseline and every lane).

## detect

| Key | Default | Meaning |
|---|---|---|
| `ignore` | `*.md`, `**/src/test/**`, `**/__tests__/**`, `*.test.*`, `*.spec.*` | Changed files that never start a service. Your patterns are added to the defaults. |

Patterns: `*` matches within a folder, `**` across folders, `?` one character. A pattern without a
slash matches at any depth.

## worktree

| Key | Default | Meaning |
|---|---|---|
| `dir` | `~/.lanes/projects/<name>/worktrees` | Where `lanes new` creates worktrees. Relative to the config file. |
| `baselineDir` | `~/.lanes/projects/<name>/baseline` | Where the baseline worktree lives. Relative to the config file. |
| `setup` | none | Shell command run in a worktree before it's used (and in the baseline worktree). Placeholders: `{{worktree}}`, `{{repo}}`, `{{configDir}}`. |
| `teardown` | none | Undoes `setup`, e.g. before `lanes sync` rebases. |
| `protect` | `[]` | Patterns of tracked files that `setup` edits locally and that must never be committed. lanes hides them from git; `lanes hooks install` adds a pre-commit guard. |
| `sparse` | none | Sparse-checkout patterns for new worktrees (`--no-cone`), e.g. `["/*", "!/legacy/"]`. |

## lanes and routing

| Key | Default | Meaning |
|---|---|---|
| `lanes.max` | `5` | Most lanes at once (1-9). |
| `lanes.portStride` | `10000` | Port offset per lane number. `stride × max + highest port` must stay below 65536. |
| `routing.baggageKey` | `lane` | Key in the `baggage` header: `baggage: lane=<name>`. |
| `routing.cookie` | `lane` | Cookie name set by `/__lane/<name>`. |
| `routing.header` | `X-Lane` | Response header naming the lane that answered (plus `<header>-Upstream`). |

## runtimes.java

| Key | Default | Meaning |
|---|---|---|
| `agentVersion` | `2.31.1` | OpenTelemetry Java agent version, downloaded once into `~/.lanes/cache`. |
| `agentPath` | none | Use a local agent jar instead of downloading (offline or mirrored setups). |
| `heap.baseline`, `heap.lane` | `768m` | Default max heap. |
| `memOverheadMb` | `640` | Container memory limit = heap + this. |
| `debugPort` | `5005` | JDWP port inside lane containers. |
| `springDefaults` | `true` | Rewrite `${VAR:http://host:port}` defaults found in `application*.yml` / `.properties`. |

## memory

| Key | Default | Meaning |
|---|---|---|
| `minHostFreeGb` | `4` | `lanes up` refuses to start if host free memory would drop below this. |
| `maxDockerPercent` | `90` | Or if Docker's memory use would pass this share of its limit. |

Users can override the check with `lanes up --force`; agents are told to stop and ask instead.

## dashboard

| Key | Default | Meaning |
|---|---|---|
| `port` | `7070` | Port of `lanes dashboard`. `LANES_DASHBOARD_PORT` overrides it. |

## agents

| Key | Default | Meaning |
|---|---|---|
| `command` | `node "<install>/bin/lanes.mjs"` in local files, `lanes` in `AGENTS.md` | How agents should invoke lanes. |
| `notes` | `[]` | Project-specific notes added to `lanes guide`. |
| `localFiles` | `[]` | Files written into every worktree and excluded from git, for agent tools that read per-checkout rules. Each is `{ path, template }`; `template` is a built-in (`cursor-rule`, `agents-md`) or a file next to `lanes.yml`. |
| `skill.name` | none | Folder name of the agent skill that `lanes agents --skill` installs into `~/.agents/skills/<name>/SKILL.md`. |
| `skill.description` | required with `skill` | When agents should use the skill; goes into its frontmatter. |
| `skill.template` | `skill` (built in) | A file next to `lanes.yml` to use instead. Placeholders: `{{skillName}}`, `{{skillDescription}}`, `{{command}}`, `{{repo}}`, `{{project}}`, `{{configDir}}`. |

```yaml
agents:
  notes:
    - The search service needs a warm index; wait for "index ready" in its log before testing.
  localFiles:
    - path: .cursor/rules/lanes.mdc
      template: cursor-rule
  skill:
    name: shop-lanes
    description: Run and test shop services in a lane. Use before building, running or testing any service.
```

## Environment variables

| Variable | Meaning |
|---|---|
| `LANES_HOME` | State, generated files, logs and caches. Default `~/.lanes`. |
| `LANES_CONFIG` | Config file to use. |
| `LANES_DASHBOARD_PORT` | Dashboard port. |
| `LANES_TIMING=1` | Print every external command with its duration. |
| `DOCKER_HOST`, `DOCKER_CONTEXT` | Honoured when talking to Docker. |
