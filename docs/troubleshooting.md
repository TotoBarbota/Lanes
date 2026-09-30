# Troubleshooting

Start with `lanes doctor`. It checks Docker, Compose, the repository, the Java agent, the baseline
worktree, the router, port conflicts and memory, and tells you the command that fixes each item.

## "The baseline stack is not running in lanes mode (router is down)"

Run `lanes baseline up`. If your stack was already running with plain `docker compose up`, that's
fine: lanes restarts it under the same project name, keeping its volumes, and hands the service
ports to the router.

## A port is in use

`lanes doctor` names the port and who holds it. Ports held by your own compose project don't
count, because `baseline up` frees them. Anything else (another dev server, another stack) must be
stopped, or change `lanes.portStride` so lane ports land elsewhere.

## 502 from the router

The service behind it isn't up yet or has crashed. `lanes status` shows health;
`lanes logs <service>` shows why. `baseline up` and `up` wait for health checks, so this mostly
appears for services without one.

## My request doesn't reach my lane

1. Check the response header `X-Lane`. Empty means the router picked the baseline.
2. Send the header explicitly: `curl -H "baggage: lane=<name>" localhost:<port>/...`, or use the
   lane's entry port, which always routes to the lane.
3. If the first hop is right but a later one isn't, the service in between isn't forwarding the
   header. For Java services, check that `JAVA_TOOL_OPTIONS` in the container contains
   `-javaagent`. For other runtimes, forward `baggage` in your HTTP client.
4. If a service calls another one by a URL lanes didn't rewrite (hard-coded in code, or built from
   parts), it bypasses the router. Put the URL in the environment or a Spring
   `${VAR:default}` placeholder.

## The browser shows a CORS error on a lane frontend

The entry service doesn't allow the lane frontend's origin (`http://localhost:1xxxx`). Add a
`cors` block to that service in `lanes.yml`; see [config.md](config.md#cors).

## `lanes up` rebuilt nothing after I changed a file

Rebuilds are skipped for services whose files haven't changed since their last build. Files in
another service's or a frontend's folder don't count. If the build depends on something outside the
worktree (a base image, a package registry), use `lanes up --rebuild`.

## The first frontend start is slow

The first start in a new worktree installs dependencies. If another checkout (the main one, the
baseline or another lane) has the same `package.json` and lockfile, lanes copies its
`node_modules` instead, which takes about a minute. Otherwise it runs a full install once.

## "Not enough memory to start this lane safely"

Close finished lanes (`lanes status` lists them), stop baseline services you don't need
(`lanes baseline pause <service>`), or lower heaps in `lanes.yml`. Users can override with
`--force`.

## Slow commands

`LANES_TIMING=1 lanes <command>` prints every external command lanes runs, with its duration.
Please include that output when reporting performance problems.
