# ProofGraph Operator v2.0.1 → v3.0.0 추적성 매트릭스

| 단계 | 계획 요구 | 구현 | 대표 시험 |
|---|---|---|---|
| Phase 0 | UX·상태 계약 | 개발 계획서, 상태 사전, keymap | TUI snapshot tests |
| v2.0.1 | 명시적 완료 상태 | `observability/contracts.mjs` | clean/recovery/denial tests |
| v2.0.1 | route/loop event | `company-runtime.mjs` | failure-loop integration |
| v2.0.1 | Failure 분리 | `observability/projection.mjs` | resolved/unresolved test |
| v2.1 | Run Registry | `control-plane/control-plane.mjs` | list/create/restart tests |
| v2.1 | REST 명령 | `control-plane/server.mjs` | auth/lifecycle/approval tests |
| v2.1 | SSE | `server.mjs`, `operator/client.mjs` | snapshot/cursor/reconnect tests |
| v2.1 | idempotency | `operator-commands` HashChainStore | same-key test |
| v2.1 | Approval Service | server-side challenge lookup | challenge redaction/approve/deny |
| v2.2 | Read-only TUI | `operator/render.mjs`, `tui.mjs` | snapshot/non-TTY tests |
| v2.3 | Pause/Resume | Runtime + API + TUI | pause/resume tests |
| v2.3 | Retry | `retryWorkItem`, TUI `R` | bounded operator retry |
| v2.3 | Approve/Deny/Abort | API + TUI confirmation | approval/denial/abort tests |
| v2.4 | OpenCode Client | `hosts/opencode-client.mjs` | fake health/SSE tests |
| v2.4 | Observer Plugin | `examples/opencode` | install/event ingest tests |
| v2.4 | Host Registry | `hosts/host-registry.mjs` | persistence/session tests |
| v2.4 | v1.1 Execution Bridge | existing `HostBridgeGraphPort` | fake bridge recovery loop |
| v2.5 | Execution Graph | `graph-layout.mjs` | graph/loop rendering tests |
| v2.5 | Organization/Cycle Views | `render.mjs` | multi-view tests |
| v2.5 | 1,000 Node | virtualization | bounded-output test |
| v3.0 | one-command start | `bin/proofgraph.mjs` | CLI start test |
| v3.0 | daemon | `bin/proofgraphd.mjs` | spawn/restart/shutdown tests |
| v3.0 | package verification | release scripts | fresh extract gate |
| Security | token separation | Control Plane + files | adversarial token tests |
| Security | ANSI/control sanitization | `render.mjs` | terminal injection test |
| Security | no file editing by TUI | API-only client | black-box state boundary |
| Integrity | state/event hash chain | existing store + API | tampering tests |

# v3.1.0 → v4.0.0 Intelligence Fabric 추적성

| 단계 | 계획 요구 | 구현 | 대표 시험/검증 |
|---|---|---|---|
| v3.1 | 역할 최소 ContextPacket | `runtime/intelligence/context-runtime.mjs` | context/model tests, secret adversarial |
| v3.1 | provenance·redaction·budget·freshness | Context source/digest/redactions/freshness | packet tamper, nested password, stale source, oversized context |
| v3.1 | verifier blind context | `blindForVerifier` | producer self-assessment exclusion |
| v3.2 | exact Model Registry | `model-router.mjs`, `registry-loader.mjs` | exact model CLI/MCP route |
| v3.2 | capability/risk/classification gate | eligibility evaluation | no-eligible fail-closed tests |
| v3.2 | registry drift 차단 | Fabric prepare/verification | resume/integrity drift black-box |
| v3.2 | immutable model observations | `ModelRouter.observe`, Fabric report ingestion | success/failure/latency/token/cost observation tests |
| v3.3 | WorkContract/Handoff | `collaboration-runtime.mjs` | lifecycle and self-contract tests |
| v3.3 | impact follow-up | `impactFollowUps` | report integration/adversarial |
| v3.4 | bounded Knowledge Graph | `knowledge-graph.mjs` | N-hop, duplicate, tamper, bound tests |
| v3.4 | actionable impact | Fabric report ingestion | terminal critical-impact gate |
| v3.5 | append-only Organization Memory | `memory-runtime.mjs` | promotion, supersession, tamper tests |
| v3.5 | sensitivity-aware recall | memory retrieval | classification filtering |
| v4.0 | execution bundle | `fabric.mjs`, `company-runtime.mjs` | end-to-end mission test |
| v4.0 | Host request binding | `graph-port.mjs` | exact model/context bridge contract |
| v4.0 | terminal Intelligence gate | `verification-runtime.mjs` | unclosed contract/impact/memory gate |
| v4.0 | REST/CLI/MCP | Control Plane, bins, `pg4_*` | 11/11 Intelligence independent black-box |
| v4.0 | TUI views | `operator/render.mjs`, `tui.mjs` | six-view snapshot/key tests |
