# ProofGraph v1.0.2 Architecture

```text
CLI / ESM API / Universal MCP / Claude Plugin
                    │
             Platform Factory
                    │
  ┌─────────────────┼──────────────────┐
  ▼                 ▼                  ▼
Graph Compiler   Adapter Router   Template Registry
  │                 │
  ▼                 ▼
Graph Runtime   Coding Agent Drivers
  │                 │
  ├── State + event hash chain
  ├── Conditional edges / bounded loops
  ├── Failure routing / human approval
  ├── Workspace Engine ── Git worktree / receipts / rollback
  └── Debugger + Inspector ── pause / step / DOT / HTTP
```

## Control plane vs data plane

The control plane is ordinary deterministic code: graph validation, routing, budgets, approvals, event commits, workspace action digests, and integrity checks. Coding agents are data-plane workers. Their outputs are normalized into typed contracts before they can affect graph state.

## Execution contracts

Each worker receives an AgentRequest containing a run ID, typed node, objective, attempt, bounded verified context, workspace descriptor, tool policy, and graph constraints. It must return an AgentResult with an outcome, structured output, artifacts, optional Failure Packet, optional dynamic tasks, and optional workspace actions.

## Adapter boundary

Adapters translate the common request to a host-specific CLI/RPC/SDK bridge and normalize its response. Vendor adapters are disabled by default. The router selects by graph role or an explicit operator override. Tool-specific installation and authentication are intentionally outside the core runtime.

Current built-in profiles target Claude print JSON, Codex exec JSON/JSONL, OpenCode run JSON events, Grok headless JSON, and Pi strict JSONL RPC. Codex output arguments remain operator-configurable because versions have changed the preferred JSON flag and event envelope. Gajae Code is a configured extension boundary: v0.11 removed the external CLI RPC/Bridge ingress and directs machine clients to SDK v3 WebSocket interfaces, so ProofGraph requires a pinned bridge or an explicit trusted command profile plus a live canary.

## State and integrity

Graph state and append-only events are committed transactionally. Every event links to the previous event hash; the last state digest is recorded in a commit event. Reports, sources, workspace proposals, debugger state, and execution receipts have separate digests.

## Workspace boundary

The Workspace Engine creates a detached disposable Git worktree. An agent can only propose typed actions. The engine returns a challenge, waits for an explicit decision, verifies the action digest, applies allowlisted actions without a shell, captures a diff and receipt, and rolls back on failure. A worktree is not a network or kernel sandbox.

## Host integrations

- CLI and ESM API are the native runtime surface.
- Universal MCP exposes platform operations to compatible hosts.
- Claude Code is shipped as a plugin with Skills, subagents, Hooks, and the legacy evidence MCP surface.
- Other coding tools connect through adapter profiles or custom adapters.

## AI Agent TUI

`runtime/tui/app.mjs` is a local operator client over integrity-verified run state. Reads use verified state/events/reports; pause, resume, and single-step delegate to the DebuggerController and GraphKernel; approve, deny, and abort delegate to challenge-bound GraphKernel APIs with double-key confirmation. The TUI never writes state files directly and therefore does not create a second control plane. It supports both an interactive alternate-screen mode and deterministic non-TTY snapshots.


## Orca execution host

The `OrcaExecutionHost` maps a ready ProofGraph node to tracked Orca Task, worktree, terminal, Dispatch, and exact AgentResult report operations. Orca owns process/worktree execution; ProofGraph owns graph state and routing. Autonomous Orca orchestration is intentionally not invoked to avoid dual coordinators.
