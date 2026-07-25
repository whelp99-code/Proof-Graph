# Changelog

## [1.1.0] - 2026-07-25 — OpenCode and Pi first-class hosts

- Promoted OpenCode to the primary ProofGraph host and Pi to the reference TUI host.
- Added the versioned `proofgraph.host.v1` command, event, and tool-policy contract.
- Added a bearer-authenticated loopback HTTP/SSE Host Bridge with optimistic revision checks.
- Added managed project/user installers for OpenCode plugins and Pi extensions.
- Added OpenCode Server execution sessions with structured output, session abort, and diff artifacts.
- Hardened Pi strict LF-delimited JSONL RPC, discovery isolation, UI fail-closed, timeout, and output bounds.
- Added host contract, adversarial, installer, CLI, mock E2E, and production-import-free independent verification.
- Added deterministic installable host package archives for OpenCode and Pi.
- Fixed the OpenCode global SSE endpoint from `/event` to the official `/global/event` and added a regression contract.
- Removed approval, denial, and abort from the OpenCode model-callable tool surface.
- Required a dedicated operator-confirmed `opencode --pure serve` worker boundary.
- Stabilized the Host Bridge startup handshake as a non-secret JSONL record.
- Pinned Host Bridge identity and rejected cross-host impersonation.
- Denied OpenCode Bridge access to approve, deny, and abort human-gate commands; these remain CLI/operator-only.
- Pinned the reviewed host contracts to OpenCode 1.18.4, `@opencode-ai/plugin` 1.18.4, and Pi 0.82.0 without claiming live certification.
- Added atomic OpenCode config-root package manifest merge, dependency-conflict refusal, symlink rejection, and rollback.
- Fixed live-preflight result precedence so an installed but unreviewed Host version cannot be promoted by a successful `--version` exit code.
- Required Pi `agent_settled` as the only final RPC completion signal; `agent_end` is diagnostic and early exit fails closed.
- Release gate: `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`.

## 1.0.2 — Orca execution-host compatibility bridge

- Added an execution-host abstraction and tracked Orca Task/worktree/terminal/Dispatch bridge.
- Added role-to-agent mapping for Claude, Codex, and custom Orca agent IDs.
- Added exact AgentResult report contracts, stale-terminal recovery, and bounded timeout checkpoints.
- Added fail-closed controls for Manual permissions, dual workspace ownership, stale/duplicate completions, path traversal, symlinks, malformed output, and premature mutation.
- Added Orca worker skill, configuration example, integration guides, 20 Orca contract/adversarial/preflight tests, and 13 black-box checks.
- Release gate: `PASS_OFFLINE_ORCA_LIVE_CANARY_REQUIRED`.

## 1.0.1 — AI Agent TUI reference integration

- Added automatic natural-language matching for the bounded `agent-tui` software-engineering profile.
- Added explicit GraphSpec validation and execution via `proofgraph graph validate|start|run`.
- Added the dependency-free `proofgraph tui` operator console with run/node selection, output/failure inspection, debugger controls, challenge-bound approve/deny, double-key abort, responsive layouts, terminal restoration, and CI-safe snapshot mode.
- Added a complete `examples/graphs/ai-agent-tui.graph.json` reference graph, machine-readable `GraphSpec v1` schema, reproducible demo evidence, and regression tests.
- Fixed the CLI human-approval source contract discovered by the end-to-end natural-language TUI graph canary.

## 1.0.0 — Graph Engineering Platform

- Unified Platform Factory for CLI, ESM, MCP, adapters, workspace, debugger, and templates.
- Added project initialization, six built-in graph templates, universal MCP, and local custom templates.
- Added source-package exports, `proofgraph` and `proofgraph-mcp` binaries.
- Added platform black-box and adversarial verification.
- Repositioned the product as a Graph Engineering development runtime, not an AI Council OS.

## 0.9.0 — Graph Debugger and Inspector

- Pause/resume, single-step, breakpoints, DOT, and token-protected loopback Inspector.

## 0.8.0 — Workspace Execution Engine

- Approval-gated Git worktrees, typed actions, receipts, diff, and rollback.

## 0.7.0 — Universal Adapter Layer

- Claude, Codex, OpenCode, GJC SDK/command extension boundary, Grok, Pi, and custom adapter contracts.

## 0.6.0 — Universal Runtime Kernel

- Adapter-independent typed Graph Runtime and CLI.

## 0.5.0 — Dynamic Graph Compiler

- Claude Code plugin baseline with dynamic graph compilation and verification.
