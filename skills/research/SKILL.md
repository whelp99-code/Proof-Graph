---
name: research
description: Run a read-only, evidence-gated deep research workflow whose final claim classifications are computed by the bundled ProofGraph MCP server.
argument-hint: <question, URL, or technical claim to verify>
disable-model-invocation: true
allowed-tools: Agent, mcp__plugin_proofgraph-claude_proofgraph__pg_start_run, mcp__plugin_proofgraph-claude_proofgraph__pg_get_active_run, mcp__plugin_proofgraph-claude_proofgraph__pg_get_status, mcp__plugin_proofgraph-claude_proofgraph__pg_complete_task, mcp__plugin_proofgraph-claude_proofgraph__pg_finalize_run, mcp__plugin_proofgraph-claude_proofgraph__pg_get_report, mcp__plugin_proofgraph-claude_proofgraph__pg_verify_integrity, mcp__plugin_proofgraph-claude_proofgraph__pg_abort_run
disallowed-tools: Bash, PowerShell, Write, Edit, NotebookEdit, WebFetch, Read, Glob, Grep
---

# ProofGraph Claude Research

Research target:

`$ARGUMENTS`

Run this workflow without substituting ordinary prose for required tool calls.

## 1. Start

Call `pg_start_run` with the full research target as `objective` and this policy:

- `max_tool_calls`: 80
- `max_source_fetches`: 24
- `max_claims`: 12
- `max_agents`: 5
- `max_wall_time_seconds`: 1800
- `min_sources_per_supported_claim`: 2
- `min_sources_per_refuted_claim`: 1

Save the returned `run_id`. If another run is active, call `pg_get_active_run`, report its ID, and continue that run only when its objective matches this request. Otherwise stop and ask the user to finalize or abort it.

## 2. Plan claims

Use the Agent tool with subagent type `proofgraph-claude:planner`. Pass the `run_id` and objective. Wait for completion. Then call `pg_get_status` and confirm that the three required tasks and at least one claim exist.

## 3. Research in parallel

In the same assistant turn, issue two Agent tool calls so they can run concurrently:

- `proofgraph-claude:researcher` with actor and task ID `research-primary`
- `proofgraph-claude:researcher` with actor and task ID `research-secondary`

Pass the same `run_id`, all claim IDs, and instruct the second researcher to prefer different source hostnames. Wait for both.

If either agent fails before calling `pg_complete_task`, call `pg_complete_task` yourself for that task with actor `coordinator`, outcome `failed`, and the exact failure summary. Never hide the failure.

## 4. Verify

Use the Agent tool with subagent type `proofgraph-claude:verifier`. Pass the `run_id`, all claim IDs, and task ID `verification`. Wait for completion. If it fails before completing the task, record that task as failed with actor `coordinator`.

## 5. Finalize

Use the Agent tool with subagent type `proofgraph-claude:synthesizer` and the `run_id`. After it returns, independently call `pg_verify_integrity` and `pg_get_report` with format `markdown`.

Output the server-generated Markdown report without changing any classification. Add only a final line in Korean stating whether the local integrity checks passed. Do not call any non-ProofGraph MCP server, local file tool, shell, write tool, or WebFetch during this workflow.

If finalization is impossible, call `pg_get_status`, explain every pending/failed/blocked task, then call `pg_abort_run` with actor `coordinator` and an honest reason.
