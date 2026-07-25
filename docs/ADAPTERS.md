# ProofGraph v1.1 Adapter and Host Certification Matrix

ProofGraph places coding tools behind typed `AgentRequest` and `AgentResult` contracts. Shipping a profile, plugin, or extension is not production certification. External tools must pass pinned-version, authentication, permission-boundary, structured-output, timeout/abort, and representative live canaries.

v1.1 separates the interactive **Host plane** from the **Worker execution plane**.

| Target | v1.1 integration | Safe default | Offline evidence | Production gate |
|---|---|---|---|---|
| Mock | in-process deterministic adapter | enabled | passed | development/CI only |
| OpenCode Host | project/user plugin + authenticated Host Bridge | loopback, bearer token, fail-closed during active runs | installer, hooks, policy, mock E2E passed | live TUI canary |
| OpenCode Worker | Server API + global SSE + JSON Schema output | disabled, loopback, auth, host tools constrained | HTTP/SSE/structured output/diff/abort passed | pinned authenticated model canary |
| Pi Host | TypeScript extension + authenticated Host Bridge | fail-closed tool interception | install, commands, session restore, approval mock E2E passed | live TUI canary |
| Pi Worker | strict LF-delimited JSONL RPC subprocess | disabled, discovery off, read-only tools, UI deny | framing/UI/timeout/abort/output bounds passed | pinned authenticated model canary |
| Claude Code | print-mode subprocess + JSON | disabled, plan mode, write/shell denied | argv/parser passed | authenticated canary |
| Codex | `exec` subprocess + configurable JSON/JSONL flags | disabled, read-only sandbox | argv/parser passed | pinned authenticated canary |
| Grok | headless JSON subprocess | disabled, isolated workspace required | argv/parser passed | authenticated canary |
| Gajae Code | pinned SDK WebSocket bridge or explicit command profile | disabled/fail-closed | configuration boundary passed | pinned bridge canary |
| Orca | tracked Task/Dispatch worktree/terminal Execution Host | disabled, Manual permissions, mutation off | contract/adversarial/black-box passed | pinned macOS canary |
| Custom | operator-supplied adapter or host | unregistered | contract tests provided | operator certification |

## OpenCode

The first-class Host uses a local plugin under `.opencode/plugins/` or `~/.config/opencode/plugins/`. It registers ProofGraph tools and commands, forwards lifecycle events, and calls the authenticated policy bridge from `tool.execute.before`.

The first-class Worker uses OpenCode Server sessions, `/global/event` SSE, JSON Schema structured output, session abort, and diff artifacts. Non-loopback servers are denied unless explicitly enabled; remote servers require HTTPS and Basic Auth. OpenCode's own `permission` configuration remains required. ProofGraph policy is an additional boundary, not a replacement for host permissions.

## Pi

The first-class Host installs an extension under `.pi/extensions/` or `~/.pi/agent/extensions/`. It provides ProofGraph commands, session persistence, approval interaction, status widgets, and fail-closed `tool_call` interception.

The Worker uses `pi --mode rpc --no-session` with discovery disabled and a read-only tool set. The client implements strict LF JSONL framing, bounded output, timeout/abort, and explicit handling for blocking `extension_ui_request` messages. Pi extensions run with the user's process permissions, so a separate ProofGraph workspace and OS/container sandbox are still required for mutation.

## Certification

```bash
proofgraph adapters
proofgraph doctor
npm run test:hosts
npm run verify:hosts
npm run hosts:preflight
npm run canary -- --adapter <name> --project /path/to/project
```

Record the exact host version, authentication mode, success and failure fixtures, prohibited-mutation count, approval-bypass count, timeout/abort/resume behavior, structured-output error rate, cost, and p50/p95 latency. The v1.1.0 gate is `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`.
