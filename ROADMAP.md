# ProofGraph Product Roadmap

ProofGraph is a **Graph Engineering development runtime**, not an AI Council OS. It reuses existing coding-agent interfaces and models while keeping typed graph compilation, execution, verification, rerouting, approval, and workspace policy under a host-neutral runtime.

## Completed

### v0.6 — Universal Runtime Kernel
- Typed AgentRequest/AgentResult
- Adapter-independent kernel
- Conditional routing, Failure Packets, checkpoints, and event integrity

### v0.7 — Universal Adapter Layer
- Claude, Codex, OpenCode, Grok, Pi, and bounded GJC extension boundary
- argv subprocess execution, timeout, cancel, output limits, and doctor status

### v0.8 — Workspace Execution Engine
- Disposable Git worktrees
- Typed write/delete/patch/command actions
- Human approval, receipts, diff, rollback, and mutation detection

### v0.9 — Graph Debugger and Inspector
- Pause/resume/single-step, breakpoints, event/route/failure inspection, DOT, and loopback HTTP

### v1.0 — Graph Engineering Platform
- Shared CLI/MCP/adapter/workspace/debugger platform
- Graph templates, project config, universal MCP, ESM API, and Claude plugin adapter

### v1.1 — OpenCode and Pi First-class Hosts
- **OpenCode primary host**: local plugin, Server/SSE workers, tool-policy bridge, and diff artifacts
- **Pi reference TUI host**: TypeScript extension, strict JSONL RPC workers, session persistence, and approval UI
- Versioned `proofgraph.host.v1` protocol
- Bearer-authenticated loopback HTTP/SSE bridge
- Managed project/user installation
- Fail-closed tool policy
- Mock E2E, adversarial, and independent black-box verification
- Gate: `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`

## Next gates

### v1.1.x — Live host certification
Pin OpenCode and Pi versions, authenticate, run at least 20 representative graphs per host, verify approval/tool-policy/abort/resume/diff/session persistence, and measure reliability, latency, and cost.

### v1.2 — Task Intelligence Compiler
Workspace discovery, TaskSpec, task archetypes, verified graph blueprints, Graph Adequacy Validator, and a bilingual compiler evaluation suite.

### v1.3 — Strong Sandbox
Container/VM execution, network policy, secret broker, resource limits, and supervised patch/test/rollback.

### v1.4 — Graph Package Registry
Signed graph packages, compatibility checks, organization policy packs, and reproducible benchmarks.

### v1.5 — Durable Distributed Execution
Remote workers, durable queues, leases, idempotent retries, recovery, and multi-project operations.

No capability is considered production-ready from implementation alone. Adversarial tests, independent reproduction, and required live host/vendor canaries remain release gates.
