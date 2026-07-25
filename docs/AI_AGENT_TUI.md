# AI Agent TUI Reference Graph and v1.0.1 Implementation

Given the objective:

```text
Develop an AI agent TUI.
```

ProofGraph auto-selects the built-in `agent-tui` template and compiles the objective into a typed GraphSpec. Critical workflows can be reviewed and executed from the explicit reference graph:

```text
examples/graphs/ai-agent-tui.graph.json
```

## Graph shape

```text
triage
 ├─ research-runtime ─┐
 ├─ research-ux ──────┼─> plan
 └─ research-safety ──┘
                         -> develop-model
                         -> develop-renderer
                         -> develop-controller
                         -> verify-functional
                         -> verify-adversarial
                         -> synthesize
                         -> success
```

Typed failures route back to research, planning, or implementation. Security failures route to the failed terminal. Every success path passes both functional and adversarial verification. The explicit graph contains 14 nodes, 38 edges, bounded retries, and fail-closed shell/workspace policies.

## Compile, validate, and run

```bash
proofgraph compile "Develop an AI agent TUI"
proofgraph graph validate examples/graphs/ai-agent-tui.graph.json
proofgraph graph run examples/graphs/ai-agent-tui.graph.json --adapter mock
```

The mock run verifies orchestration, state transitions, routing, and integrity. It does not certify a live vendor model.

## Operator TUI

```bash
proofgraph tui
proofgraph tui <run_id>
proofgraph tui <run_id> --snapshot
```

The TUI renders runs, graph/agent nodes, details/approvals, and events. It reads only integrity-verified state and delegates every mutation to the existing GraphKernel or DebuggerController.

Keys:

```text
Tab / arrows   move focus and selection
p              pause or resume and execute ready nodes
s              execute one node and pause again
a, a           approve a pending approval
d, d           deny a pending approval
x, x           abort the run
r              refresh
?              safety help
q / Ctrl-C     quit
```

Approve, deny, and abort require the same key twice within four seconds. Snapshot mode emits no terminal control sequences and works without a TTY.

## Verification

```bash
npm test
npm run preflight
npm run verify:tui
```

The independent TUI verifier imports no production module. It exercises the public CLI, explicit GraphSpec, mock execution, persisted artifacts, snapshot rendering, tamper isolation, and non-TTY rejection.
