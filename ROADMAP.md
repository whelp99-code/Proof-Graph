# ProofGraph Roadmap

## Vision

ProofGraph is an evidence-centered Agent Control Plane that records claims, evidence, verification, decisions, failures, budgets, and provenance as reproducible execution state.

The current product is a Claude Code-only, read-only research plugin. The long-term direction is to validate the governance model on Claude first, then expand it to additional agents and providers.

## Product principles

1. No silent failure.
2. No unverified promotion.
3. Fail closed when state, authority, or integrity cannot be verified.
4. Keep budgets, permissions, transitions, and approvals deterministic.
5. Prefer primary evidence, tests, and reproduction over agent consensus.
6. Scale agent count only when measured quality improves.

## Phase 0 — Research and local execution kernel

**Status: Complete**

- Typed DAG execution
- Parallel map/fan-in
- Checkpointing, resume, and cache experiments
- Structured output
- Claim/evidence ledger
- Mock-based 1,000 logical-task load test
- Independent and adversarial validation foundations

Findings from this phase—budget enforcement, cache contamination, failed-run recovery, and fabricated evidence promotion—were incorporated into the Claude-only MVP.

## Phase 1 — Claude Code MVP

**Version: v0.2.x**  
**Current status: Offline verified; real Claude canary required**

Implemented:

- Claude Code plugin packaging
- Planner, researcher, verifier, and synthesizer subagents
- Local stdio MCP server
- PreToolUse, Stop, and audit hooks
- Read-only tool policy
- Safe HTTPS retrieval and SSRF protection
- Exact-quote verification
- Role-scoped state mutations
- Hard call, source, agent, and wall-time budgets
- Claim/evidence/verdict ledger
- Event hash chain and artifact integrity checks
- Unit, integration, adversarial, and independent black-box validation

### v0.2.1 — Real Claude canary

- Run at least 20 real Claude Code cases
- Include X posts, official documentation, technical claims, and repository analysis
- Zero false `supported` promotions
- Zero forbidden tool executions
- Every run ends with explicit `finalize` or `abort`
- 100% source-to-quote integrity
- Measure cost, latency, and failure modes

Release gates:

- `claude plugin validate . --strict`
- Real Linux/macOS install tests
- Hook, MCP, and subagent lifecycle validation
- Published canary evidence and raw validation logs

### v0.2.2 — Operational hardening

- Better interrupted-run recovery
- Externalized policy configuration
- Source trust tiers
- Stronger semantic-support cross-validation
- Stronger fixture/production isolation
- GitHub Actions, CodeQL, and Dependabot
- Signed release artifacts and SBOM

### v0.2.3 — Research templates

- Technical claim validation
- Official documentation comparison
- Open-source project audit
- Product and service comparison
- Paper and benchmark verification
- Evidence gathering for PRD and SPEC creation

## Phase 2 — Claude Agent Runtime

**Target: v0.3.x**

- Agent Manifest and Agent Registry
- Per-node role, model, tool, and budget configuration
- Delegation tokens and privilege attenuation
- Tool Broker and human approval gates
- SQLite Event Store
- Local REST/SSE control plane
- Pause, resume, cancel, and retry
- OpenTelemetry-compatible traces
- Project and run artifact storage

Completion criteria:

- Unregistered agents cannot run
- Every model/tool call has a Run ID and Agent ID
- Child privileges cannot exceed parent privileges
- Risky tools require approval before execution
- State survives control-plane restart
- A complete run can be reconstructed from traces and the ledger

## Phase 3 — Operator Console

**Target: v0.4.x**

The TUI is an operator client, not the execution engine.

- Runs dashboard
- Workflow graph
- Agent/node inspector
- Live event stream
- Approval queue
- Evidence ledger
- Budget, cost, and latency views
- Failed-node retry and run cancellation

The TUI never edits runtime state directly; all commands go through the Control Plane API.

## Phase 4 — Multi-provider expansion

**Target: v0.5.x**

Adapters:

- Claude Agent SDK
- OpenAI Agents SDK
- Generic OpenAI-compatible HTTP
- Local models
- CLI/subprocess agents
- MCP client/server adapters

Control levels:

- L0 Unmanaged
- L1 Observed
- L2 Governed
- L3 Controlled
- L4 Verifiable

L0 and L1 outputs are never automatically promoted to confirmed results.

## Phase 5 — Durable distributed runtime

**Target: v0.6.x**

- Temporal or equivalent durable execution backend
- PostgreSQL RunStore
- Object storage
- Remote workers and queue routing
- Idempotency keys and duplicate suppression
- Failure injection and recovery tests
- Scale tests at 100, 250, 500, and 1,000 logical tasks

The term “1,000” will always distinguish cumulative tasks, active tasks, and concurrent model requests.

## Phase 6 — AI Council OS integration

**Target: v1.0**

```text
User objective
  → Multi-AI / multi-agent debate
  → Claim and conflict graph
  → Independent verification with unresolved issues preserved
  → Human approval
  → Decision Graph
  → PRD / SPEC / Issues / Marketing artifacts
  → Execution tools and external systems
```

v1.0 criteria:

- Debate timeline and position-change tracking
- Separation of agreements and unresolved issues
- Claim-level provenance
- Human approval gates
- Artifact-to-evidence traceability
- GitHub, Jira, and document-system integration
- Team permissions and audit logs
- Cost and quality scorecards

## Continuous validation track

Every phase retains:

- Unit and integration tests
- Adversarial tests
- Independent black-box validation
- Real-provider canaries
- Fault injection
- Quality/cost comparison against baselines
- Published failures and limitations
- Reproducible release manifests

## Current priorities

1. GitHub Actions validation
2. Real Claude CLI strict validation
3. Twenty-case Claude canary
4. Canary fixes and v0.2.1
5. Signed v0.2.1 release
6. Begin Agent Registry and Tool Broker design

## Status vocabulary

- **Implemented**: code exists
- **Offline verified**: simulation, static, and black-box tests pass
- **Provider verified**: validated on real Claude/API execution
- **Operationally verified**: repeated operations and fault injection pass
- **Released**: tag, release artifact, checksum, and changelog published

ProofGraph Claude MVP is currently **Implemented + Offline verified**.