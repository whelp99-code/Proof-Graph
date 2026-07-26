# ProofGraph v1.1.0

**The Graph Engineering Runtime for AI Coding.**

ProofGraph turns an engineering objective into a typed, stateful, verifiable execution graph. It is not an AI Council OS and it is not another foundation model. It is a development runtime that can route work to Claude Code, Codex, OpenCode, Gajae Code integrations, Grok Build, Pi, or custom adapters while keeping graph state, failures, approvals, workspace changes, and verification under deterministic control.

## What ships in v1.1.0

- Deterministic natural-language → GraphSpec compiler
- Conditional edges, bounded retry loops, dynamic fan-out, checkpoints, and integrity-protected events
- Universal adapter protocol plus built-in profiles for Claude, Codex, OpenCode, Grok, Pi, and GJC
- Approval-gated disposable Git worktrees with patch/test/rollback receipts
- Breakpoints, pause/resume, single-step, DOT export, and token-protected loopback Inspector
- **OpenCode first-class Host**: local plugin, Server/SSE worker sessions, permission/tool-policy bridge, and diff artifacts
- **Pi first-class Host**: TypeScript extension, strict JSONL RPC workers, session persistence, approval UI, and tool interception
- Versioned `proofgraph.host.v1` command/event/tool-policy protocol over an authenticated loopback HTTP/SSE bridge
- Managed project/user installers for OpenCode and Pi
- Orca execution-host compatibility bridge retained as the third-priority host
- Optional dependency-free local TUI retained for debugging and CI snapshots
- Explicit GraphSpec JSON validation and execution through CLI and ESM APIs
- Built-in agent-tui, feature, bugfix, refactor, security-audit, migration, and research graphs
- CLI, reusable ESM API, universal stdio MCP server, and Claude Code plugin adapter
- Independent evidence, graph, platform, adversarial, and package verification

## Install from source

Requirements: Node.js 20+ and Git. The ProofGraph core has no external runtime dependency. The reviewed Pi 0.82.0 host contract requires Node.js 22.19.0 or newer when Pi itself is used.

```bash
git clone https://github.com/whelp99-code/Proof-Graph.git
cd Proof-Graph
npm ci --ignore-scripts
npm test
npm link
proofgraph version
```

Without `npm link`, use `node bin/proofgraph.mjs` in place of `proofgraph`.

## Primary hosts: OpenCode and Pi

ProofGraph now treats **OpenCode as the primary host** and **Pi as the reference TUI host**. The host owns the interaction surface; ProofGraph remains authoritative for graph compilation, ready-node routing, failures, verification, approvals, workspace mutation, and terminal state.

```bash
# Inspect host priority and capabilities
proofgraph hosts

# Install into the current project
proofgraph host install opencode --scope project
proofgraph host install pi --scope project

# Start an authenticated loopback bridge
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
proofgraph host serve opencode --port 8743 --token "$PROOFGRAPH_HOST_TOKEN"
```

The OpenCode plugin is installed under `.opencode/plugins/`; the installer also merges `.opencode/package.json` and pins `@opencode-ai/plugin@1.18.4` without deleting existing user fields or dependencies. Conflicting versions fail closed unless `--force` is explicit. OpenCode installs local-plugin dependencies with Bun at startup. The Pi extension is installed under `.pi/extensions/`; Pi supplies its core extension imports, so they remain peer dependencies. Both intercept host tool activity and fail closed during an active run when the ProofGraph policy bridge is unavailable. OpenCode workers must use a separate `opencode --pure serve` instance and set `pure_worker_confirmed=true` only after operator verification. OpenCode model tools cannot approve, deny, or abort a run; those actions use the ProofGraph CLI. The reviewed offline contract targets are OpenCode CLI/server 1.18.4, `@opencode-ai/plugin` 1.18.4, and Pi 0.82.0. These are contract targets, not live certification; `npm run hosts:preflight` requires an exact target match when a host binary is present. See [OpenCode and Pi integration](./docs/OPENCODE_PI_INTEGRATION.md).

## First project

```bash
cd /path/to/repository
proofgraph init
proofgraph templates
proofgraph compile "Fix the authorization regression" --template bugfix
proofgraph run "Explain one deterministic invariant in this repository"
```

The safe default adapter is `mock`. Live coding tools are disabled until explicitly configured and canary-tested.

## Built-in debug TUI

```bash
proofgraph compile "Develop an AI agent TUI" # agent-tui is auto-selected
proofgraph graph validate examples/graphs/ai-agent-tui.graph.json
proofgraph graph run examples/graphs/ai-agent-tui.graph.json --adapter mock
proofgraph tui --snapshot
```

The built-in TUI is a debugging and CI-snapshot aid, not the primary reference UI. It uses `Tab/arrows` for panel focus, `j/k` for run or node selection, `p` for pause/resume, `s` for single-step, `a,a` for approve, `d,d` for deny, `x,x` for abort, `r` for refresh, and `q` to quit. Destructive actions require the same key twice within four seconds. It never edits run state directly; actions go through `DebuggerController` and `GraphKernel`. See [AI Agent TUI reference](./docs/AI_AGENT_TUI.md) and [GraphSpec v1](./docs/GRAPH_SPEC.md).

## Operator flow

```bash
# Create the graph without running workers
proofgraph start "Implement audited token rotation" --template feature

# Add a breakpoint before the direct node kind or a specific node
proofgraph debug break <run_id> kind direct
proofgraph resume <run_id>
proofgraph inspect <run_id> text
proofgraph inspect <run_id> dot

# Bypass a breakpoint once and continue
proofgraph debug bypass <run_id> <node_id>
proofgraph resume <run_id>
```

## Approval-gated workspace execution

Enable `workspace.enabled` in `proofgraph.config.json`, then use a clean Git repository:

```bash
proofgraph workspace create <run_id>
proofgraph workspace propose <run_id> actions.json
proofgraph workspace approve <run_id> <challenge> approve
proofgraph workspace execute <run_id>
proofgraph workspace diff <run_id>
proofgraph workspace rollback <run_id>
```

A Git worktree isolates files, not the network or operating-system kernel. Untrusted commands require an external container/sandbox.

## Universal MCP

```bash
proofgraph-mcp
# or
proofgraph mcp
```

The universal server exposes compile, start, run, resume, status, report, integrity, debugger, template, adapter, inspector, and workspace tools over stdio MCP. See [`examples/universal-mcp.json`](./examples/universal-mcp.json).

## Claude Code adapter

The repository remains a valid Claude Code plugin. For a local session:

```bash
claude plugin validate . --strict
claude --plugin-dir .
```

Then use:

```text
/proofgraph-claude:graph <engineering objective>
/proofgraph-claude:research <claim or URL>
```

## Adapter policy

All vendor adapters are disabled by default. Run:

```bash
proofgraph adapters
npm run canary -- --adapter claude --project /path/to/repo
```

The built-in profiles use each host's supported non-interactive surface: Claude print JSON, Codex `exec` JSON/JSONL, OpenCode authenticated Server API with structured output (or explicit legacy subprocess), Grok headless JSON, and Pi strict JSONL RPC with discovery disabled and read tools only by default. Codex output flags are configurable because its JSON event surface has changed across releases. Gajae Code v0.11 removed the external `--mode rpc`, `rpc-ui`, and `bridge` CLI ingress; ProofGraph therefore keeps GJC fail-closed until a pinned SDK v3 WebSocket bridge or an explicit trusted command profile is configured.

An adapter is production-eligible only after its local installation, authentication, structured-output contract, permission boundary, timeout behavior, and representative canaries pass.

## Orca execution host

Orca is integrated as an execution host rather than a model adapter. Orca owns the UI, worktree, terminal, and agent process; ProofGraph remains authoritative for GraphSpec, ready-node routing, verification, approval policy, and terminal status.

```bash
cp examples/orca-bridge.config.json proofgraph.config.json
# Set Orca Agent Permissions to Manual.
# Find the registered repo ID and set adapters.orca.repo_selector to id:<repoId>.
orca status --json
orca repo list --json
proofgraph adapters
proofgraph run "Return one concise bounded answer" --adapter orca
```

Orca-hosted runs require `workspace.enabled=false`; Orca is the sole worktree owner. An explicit `repo_selector` is also required so automation never targets whichever repo happens to be active. The bridge uses tracked manual Task/Dispatch primitives and does not invoke Orca's autonomous coordinator loop. See [Orca integration](./docs/ORCA_INTEGRATION.md).

## Verification

```bash
npm test
npm run preflight
npm run verify:independent
npm run verify:graph
npm run verify:platform
npm run verify:tui
npm run verify:orca
npm run verify:hosts
npm run hosts:preflight
npm run verify:package
```

v1.1.0 is **offline verified; OpenCode live canary completed (2026-07-25); Pi and other vendor canaries remain required**. Current evidence: 232/232 automated tests, 60/60 adversarial tests, 46/46 OpenCode/Pi host tests, 74/74 independent black-box checks, 27 PASS / 0 FAIL / 1 SKIP static preflight, and 92.11% line / 74.82% branch / 88.94% function coverage. The static-preflight skip is Claude CLI strict validation because that CLI is not installed in the verification environment. OpenCode live canary verified: bridge server health, SSE events, tool-policy enforcement (read-only allow, mutation deny without run), compile command, operator-command boundary (approve/deny/abort blocked for model), host identity mismatch rejection, unauthorized access rejection, and plugin module loading (5 hooks registered). Pi live canary remains pending (Pi 0.82.0 not installed). The release does not claim that real Pi authentication, model behavior, permission UI, latency, or cost were exercised in this build environment.

## Packages

- **proofgraph** (root, v1.1.0) — Graph Kernel: GraphSpec, routing, verification, approval, workspace policy, OpenCode/Pi host integrations.
- **@proofgraph/standalone** (`packages/standalone/`, v5.0.0-rc.1) — Standalone AI Organization OS: task intelligence, organization engineering, company runtime, operator TUI, control-plane server, native model gateway, collaboration fabric.

## Documentation

- [Korean installation and operations](./README_KO.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [GraphSpec v1](./docs/GRAPH_SPEC.md)
- [AI Agent TUI reference](./docs/AI_AGENT_TUI.md)
- [OpenCode and Pi integration](./docs/OPENCODE_PI_INTEGRATION.md)
- [OpenCode and Pi host architecture](./docs/HOSTS_OPENCODE_PI.md)
- [Orca integration](./docs/ORCA_INTEGRATION.md)
- [Adapter certification matrix](./docs/ADAPTERS.md)
- [Korean operations guide](./docs/OPERATIONS_KO.md)
- [Security model](./docs/SECURITY_MODEL.md)
- [Known limitations](./docs/LIMITATIONS_KO.md)
- [v1.1.0 OpenCode/Pi verification](./verification/OPENCODE_PI_INTEGRATION_VERIFICATION_KO.md)
- [v1.1.0 release decision](./verification/V1_1_0_RELEASE_DECISION_KO.md)
- [v1.0.2 Orca integration verification](./verification/ORCA_INTEGRATION_VERIFICATION_KO.md)
- [v1.0.2 release decision](./verification/V1_0_2_RELEASE_DECISION_KO.md)
- [v1.0.1 AI Agent TUI verification](./verification/V1_0_1_AGENT_TUI_VERIFICATION_KO.md)
- [v1.1.0 OpenCode/Pi release notes](./docs/releases/v1.1.0.md)
- [v1.0.2 Orca release notes](./docs/releases/v1.0.2.md)
- [v1.0.1 release notes](./docs/releases/v1.0.1.md)
- [v1.0.1 release decision](./verification/V1_0_1_RELEASE_DECISION_KO.md)
- [v1.0 release verification](./verification/V1_RELEASE_VERIFICATION_KO.md)
- [v1.0 release decision](./verification/V1_RELEASE_DECISION_KO.md)
- [Roadmap](./ROADMAP.md) / [한국어 로드맵](./ROADMAP_KO.md)

License: MIT.
