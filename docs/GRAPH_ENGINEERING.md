# ProofGraph Graph Engineering v1.0

> v1.0 integrates this compiler/runtime with universal adapters, approval-gated worktrees, a debugger, templates, CLI, ESM API, and universal MCP. Claude Code is one host adapter, not the product boundary.

ProofGraph Graph Engineering is a bounded control system, not an agent-count mechanism. It compiles objectives into typed nodes and conditions, routes by state and risk, sends failures back to the correct role, pauses high-risk work for approval, and promotes only verifier-passed outputs to a success terminal.

## Layers

- **v0.3 Conditional Runtime:** typed nodes/edges, Failure Packets, approval nodes, bounded reverse routing.
- **v0.4 Adaptive Runtime:** complexity/risk routing, bounded fan-out, joins, verification strength, repeated-failure escalation, dynamic expansion.
- **v0.5 Dynamic Compiler:** deterministic objective-to-GraphSpec generation followed by static safety validation.

The compiler uses a restricted condition vocabulary (`outcome`, `route`, `failure_type`, `approval`, `verification`, `always`) rather than arbitrary executable expressions.

## Core safety properties

- Every successful path crosses a verifier.
- Every cycle contains verification or human approval and finite limits.
- High-risk nodes require approval.
- Default graphs cannot request workspace-write or shell capabilities.
- Dynamic expansion revalidates the full graph and updates its digest/revision.
- Worker-supplied `recommended_route` is advisory; the runtime chooses the route.
- Third repeated failures escalate to human/failure rather than looping forever.

## Default topology

```text
triage → direct/research/plan/human
research shards → all-join plan
a plan → artifact-only develop → verify
verify pass → synthesize → success
verify failure → research/plan/develop/human/partial by typed failure
```

Human approval uses a persisted local challenge for state continuity. It is not cryptographic human-identity attestation.