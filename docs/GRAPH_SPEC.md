# ProofGraph GraphSpec v1

ProofGraph executes a bounded JSON `GraphSpec v1`. Natural language is an authoring surface; the runtime only accepts a normalized and statically validated GraphSpec.

```text
objective → safe template profile → deterministic compiler → GraphSpec → static safety validation → runtime
```

Two supported authoring modes:

```bash
# Natural language; agent-tui is matched automatically.
proofgraph compile "Develop an AI agent TUI"

# Reviewed, version-controlled explicit graph.
proofgraph graph validate examples/graphs/ai-agent-tui.graph.json
proofgraph graph run examples/graphs/ai-agent-tui.graph.json --adapter mock
```

The canonical object contains `graph_id`, `name`, `objective`, `entry_node`, typed `nodes`, conditional `edges`, bounded `limits`, and fail-closed `policy`. Node kinds are limited to `triage`, `direct`, `research`, `plan`, `develop`, `verify`, `human_approval`, `synthesize`, and `terminal`. Edge conditions are limited to `always`, `outcome`, `route`, `failure_type`, `approval`, and `verification`; arbitrary expressions or JavaScript are not allowed.

The machine-readable interchange schema is [`schemas/graphspec-v1.schema.json`](../schemas/graphspec-v1.schema.json). The runtime command below remains authoritative because it additionally checks topology, reachability, verifier coverage, cycles, risk gates, capabilities, and execution bounds.

```bash
proofgraph graph validate path/to/graph.json
```
