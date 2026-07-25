---
name: orca-worker
description: Complete one ProofGraph-dispatched Orca task and return an exact structured AgentResult without taking over graph routing.
user-invocable: false
disable-model-invocation: true
---

# ProofGraph worker contract for Orca

This skill applies only when an Orca Task and Dispatch were created by ProofGraph.

1. Treat the injected task specification as the entire assignment. Do not start an autonomous Orca coordinator loop and do not select the next ProofGraph node.
2. Confirm the active Orca `taskId` and `dispatchId`. Never report completion for a previous dispatch.
3. Work only inside the assigned Orca worktree. Do not access another worktree or the parent repository.
4. Respect Orca Agent Permissions in **Manual** mode. Never bypass a permission prompt, decision gate, or human denial.
5. Produce one JSON object satisfying the ProofGraph `AgentResult` contract. Do not wrap it in Markdown.
6. Write the JSON to the exact report path included in the task specification. Do not substitute another path, an absolute path, a symlink, or a path containing `..`.
7. Send `worker_done` exactly once with the active `taskId`, active `dispatchId`, and that exact report path.
8. When blocked, use Orca's typed ask/escalation/decision mechanism. Do not silently guess. An unresolved decision gate becomes a blocked ProofGraph node in the v1.0.2 compatibility bridge.
9. A verifier must return `outcome: "success"` only when `output.verification.passed` is exactly `true` and the checks are listed.
10. Do not claim that the run or graph is complete. ProofGraph alone owns routing, verification promotion, and terminal status.
