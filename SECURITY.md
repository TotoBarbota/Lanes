# Security

lanes is a local development tool. It is not meant to be exposed to a network.

## What it runs and exposes

- **The router** publishes your services' ports and every lane's entry and frontend ports on the
  host, the same way your compose file already publishes service ports. Treat them like any local
  development port.
- **The dashboard** (`lanes dashboard`) serves status and container logs on `localhost`, and
  can start, update and close lanes. It listens on `127.0.0.1` only. Actions need a token that is
  embedded in the dashboard page, and requests with another `Host` or `Origin` are refused, so
  other websites open in your browser can't trigger them. Logs can contain secrets from your
  services; don't expose the port.
- **Java lane containers** open a JDWP debugger port on the host (see the ports table in
  [how-it-works](docs/how-it-works.md#ports)). A debugger can run arbitrary code in the service.
  Don't run lanes on machines where untrusted users can reach these ports.
- **Commands from `lanes.yml`** (`worktree.setup`, `uis.*.command`, `uis.*.install`) run as shell
  commands on your machine. Review a `lanes.yml` from someone else as you would a script.
- **The OpenTelemetry Java agent** is downloaded from its official GitHub release on first use.
  Set `runtimes.java.agentPath` to use a jar you've vetted or mirrored.

## Reporting a vulnerability

Please report security issues privately rather than in a public issue: use **Report a
vulnerability** on the repository's
[Security tab](https://github.com/TotoBarbota/Lanes/security/advisories/new).
