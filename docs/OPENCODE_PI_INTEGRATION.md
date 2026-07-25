# ProofGraph v1.1 — OpenCode and Pi Host Integration

ProofGraph prioritizes **OpenCode as the primary host** and **Pi as the reference TUI host**. The hosts provide the user experience; ProofGraph remains authoritative for GraphSpec compilation, ready-node routing, verification, approvals, workspace policy, failures, and terminal state.

```text
OpenCode / Pi UI
       ↓ plugin or extension
Authenticated loopback Host Bridge
       ↓
ProofGraph Runtime and Policy
       ↓
OpenCode Server sessions / Pi JSONL RPC workers
```

## Install

```bash
proofgraph host install opencode --scope project
proofgraph host install pi --scope project
```

Global installation is available with `--scope user`. Existing managed plugin files and symlinked roots are rejected unless the operation is explicitly forced. For OpenCode, the installer transactionally merges the existing config-root `package.json`, pins `@opencode-ai/plugin@1.18.4`, preserves unrelated fields and dependencies, and rolls back all staged files if any destination fails. A conflicting plugin dependency is rejected unless `--force` is explicit.

Build the standalone host packages reproducibly with:

```bash
npm run package:hosts
```

Outputs:

```text
dist/hosts/proofgraph-host-opencode-1.1.0.tgz
dist/hosts/proofgraph-host-pi-1.1.0.tgz
```

The packaging command validates package names, versions, host contract metadata, dependency boundaries, and the exact archive file lists after cleaning the previous host distribution directory.

## Reviewed contract targets

```text
OpenCode CLI/server       1.18.4
@opencode-ai/plugin       1.18.4
Pi CLI                    0.82.0
Pi Node runtime           >=22.19.0
```

These values describe the source contracts reviewed by v1.1.0. They are not a production certification. When a binary is installed, `npm run hosts:preflight` parses its version and requires an exact contract-target match; authenticated representative canaries are still required. Pi core extension packages and `typebox` remain `peerDependencies` because Pi supplies them to extensions.

## Run the bridge

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8743"
proofgraph host serve opencode --port 8743 --token "$PROOFGRAPH_HOST_TOKEN"
```

Use a separate port/token and `host serve pi` for Pi. The bridge exposes authenticated commands, tool-policy decisions, events, SSE, health, and capability negotiation using protocol `proofgraph.host.v1`.

A bridge instance is pinned to exactly one configured host identity; cross-host claims are rejected. The OpenCode bridge also rejects approve, deny, and abort commands even with a valid bearer token, so human-gate actions remain on the ProofGraph CLI/operator path.

## Safety boundary

- loopback bind by default
- bearer token required
- bounded bodies and strict schemas
- optimistic revision checks
- fail-closed policy behavior during an active run
- mutation requires an isolated ProofGraph workspace and approval policy
- live vendor canaries required before production eligibility

See [the Korean operations guide](./OPENCODE_PI_INTEGRATION_KO.md) for complete setup, config examples, commands, and release gates.


## OpenCode human gate and worker isolation

The UI host and worker server must be separate. Start the worker with `opencode --pure serve`, then set `pure_worker_confirmed=true`. Approval, denial, and abort are never exposed as model-callable OpenCode tools; use the ProofGraph CLI and resume the run explicitly.
