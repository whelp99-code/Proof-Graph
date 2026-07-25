---
name: graph
description: Compile and execute a bounded dynamic Graph Engineering workflow with role routing, verification loops, human approval, and deterministic reports.
argument-hint: <objective or project task>
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, TaskOutput, TaskStop, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_preview, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_start, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_get_status, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_resolve_approval, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_get_report, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_verify_integrity, mcp__plugin_proofgraph-claude_proofgraph__pg_graph_abort
disallowed-tools: Bash, PowerShell, Write, Edit, NotebookEdit, WebFetch, Read, Glob, Grep, WebSearch
---

# ProofGraph Dynamic Graph Engineering

Objective:

`$ARGUMENTS`

The bundled MCP server is the control plane. Do not replace required tool calls with prose and do not choose routes manually.

## 1. Preview and start

Call `pg_graph_preview` with the complete objective, `mode: "auto"`, and no invented signals unless the user explicitly supplied complexity, risk, or mode constraints. Read the returned assessment, graph digest, initial route, fan-out, verification strength, warnings, and safety validation.

Then call `pg_graph_start` with the same objective and inputs. Save `run_id`.

If a different ProofGraph run is already active, report it. Continue it only when the objective clearly matches; otherwise ask the user to finalize or abort the prior run.

## 2. Orchestration loop

Repeat at most 30 orchestration rounds:

1. Call `pg_graph_get_status`.
2. If `status` is `finalized`, go to Final report.
3. If `status` is `waiting_approval`:
   - Present the exact node, risk, reason, and intended operation from `pending_approvals`.
   - Use `AskUserQuestion` to request an explicit Approve or Deny decision. Do not infer approval from silence or earlier messages.
   - Call `pg_graph_resolve_approval` with actor `human`, the exact approval ID and challenge, the explicit decision, `decision_source: "AskUserQuestion"`, and a short comment reflecting the answer.
   - Continue the loop.
4. If one or more nodes are ready, issue their Agent calls in the same assistant turn, up to the graph’s parallel limit. For each node use exactly its returned `agent_type` and pass:
   - `run_id`
   - `node_id`
   - objective
   - node kind, role, tool policy, attempt/max attempts, and metadata
   - instruction to claim and complete that exact node
5. Wait for all spawned agents. Call `pg_graph_get_status` again. An agent’s prose is not completion evidence; only MCP state counts.
6. When an agent exits before completing its node, delegate the same ready node again if attempts remain. If it remains `running` without completion, report the inconsistency and call `pg_graph_abort` rather than forging completion.
7. If there are no ready nodes, no running nodes, and no pending approval while the run is not terminal, call `pg_graph_abort` with an honest deadlock reason.
8. If the run is `budget_exceeded` or `failed`, report all recorded failures and call `pg_graph_abort` unless the MCP server already finalized a partial/failed terminal.

Never spawn an agent type that is not returned for a ready node. Never call Write, Edit, shell, WebFetch, external MCP, or another Skill.

## 3. Final report

After finalization:

1. Call `pg_graph_verify_integrity`.
2. Call `pg_graph_get_report` with `format: "markdown"`.
3. Return the server-generated report without changing terminal status or quality-gate result.
4. Add one Korean line stating whether local integrity checks passed and whether any human approval identity remains self-attested.

The default Claude plugin developer remains artifact-only and direct Write/Edit/Shell access is denied. Workspace mutation is available only through the separately configured universal ProofGraph Workspace Engine, which executes challenge-bound approved actions inside a disposable Git worktree.
