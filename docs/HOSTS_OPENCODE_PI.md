# OpenCode and Pi reference hosts

ProofGraph v1.1.0 promotes OpenCode to the primary reference host and Pi to the secondary reference host. Neither project is forked. ProofGraph remains authoritative for GraphSpec, state transitions, failure routing, verification, approvals, workspace policy, and terminal status.

## Architecture

```text
OpenCode TUI / Pi TUI
        │ plugin / extension
        ▼
ProofGraph Host Bridge
  authenticated commands + SSE events + tool policy
        │
        ▼
ProofGraph Runtime
        ├─ OpenCode Server execution adapter
        └─ Pi strict JSONL RPC execution adapter
```

The UI-host integration is separate from worker execution. This preserves one graph runtime while allowing either host to provide the developer experience.

## Install managed integrations

```bash
proofgraph host install opencode --scope project
proofgraph host install pi --scope project
```

Project targets are `.opencode/plugins/` and `.pi/extensions/`. Use `--scope user` for `~/.config/opencode/` and `~/.pi/agent/`. OpenCode installation also merges the config-root `package.json` with the pinned local-plugin dependency while preserving user content. The installer rejects symlink traversal, preflights all destinations, uses transaction-style backup/rollback, and does not overwrite managed plugin files without `--force`.

Reviewed contract targets: OpenCode 1.18.4, `@opencode-ai/plugin` 1.18.4, and Pi 0.82.0. Pi 0.82.0 requires Node.js 22.19.0 or newer. These are offline contract targets; live canaries remain mandatory.

## Start the Host Bridge

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8742"
proofgraph host serve opencode --project "$PWD" --port 8742 --token "$PROOFGRAPH_HOST_TOKEN"
```

The bridge is loopback-only by default and exposes the versioned `proofgraph.host.v1` command/event/tool-policy contract.

A bridge instance is pinned to its configured host identity. Cross-host claims are rejected, and the OpenCode bridge cannot execute approve, deny, or abort; those human-gate actions stay on the ProofGraph CLI/operator path.

## OpenCode

Configure the worker adapter to use a fixed, authenticated local server:

```json
{
  "adapters": {
    "opencode": {
      "enabled": true,
      "transport": "server",
      "server_url": "http://127.0.0.1:4096",
      "username": "opencode",
      "password_env": "OPENCODE_SERVER_PASSWORD",
      "allow_remote": false,
      "allow_host_tools": false,
      "require_isolated_workspace": true,
      "pure_worker_confirmed": true
    }
  }
}
```

```bash
export OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 32)"
opencode --pure serve --hostname 127.0.0.1 --port 4096
```

The local plugin adds `/pg`, `/pg-status`, `/pg-report`, ProofGraph tools, lifecycle event projection, and fail-closed `tool.execute.before` policy enforcement. The worker adapter requests structured output, aborts malformed sessions, captures session diffs, bounds JSON/SSE responses, and rejects remote endpoints unless explicitly enabled with HTTPS and Basic Auth.

## Pi

Start Pi normally after installing the project extension:

```bash
pi
```

The extension adds `/pg`, `/pg-status`, `/pg-resume`, `/pg-report`, `/pg-integrity`, `/pg-approve`, `/pg-deny`, and `/pg-abort`, plus ProofGraph tools and tool-call policy interception.

The worker adapter uses strict LF JSONL RPC and, by default, launches Pi with resource discovery disabled and only read tools enabled:

```text
--mode rpc --no-session
--no-extensions --no-skills --no-prompt-templates --no-context-files
--tools read,grep,find,ls
```

Blocking extension UI is denied in unattended runs, only `agent_settled` is accepted as final completion, and mutation tools require a ProofGraph isolated workspace.

## Verification

```bash
npm run test:hosts
npm run verify:hosts
npm run hosts:preflight
```

Offline verification uses fake OpenCode HTTP and Pi JSONL RPC endpoints. Pinned, authenticated live canaries remain mandatory before production eligibility.


## OpenCode human gate and worker isolation

The UI host and worker server must be separate. Start the worker with `opencode --pure serve`, then set `pure_worker_confirmed=true`. Approval, denial, and abort are never exposed as model-callable OpenCode tools; use the ProofGraph CLI and resume the run explicitly.
