# Changelog


## [5.0.0] - 2026-07-26

### Added
- Truthfulness Gate, Native Model Gateway, Sandbox Tool Runtime, bounded Worker Runtime.
- Explicit simulation/hosted/native_cloud/native_local execution modes.
- Standalone independent fake-provider black-box verification.

### Security
- Simulation cannot produce verified artifacts or a passing quality gate.
- Remote model endpoints require HTTPS; workspace escape and non-allowlisted commands are blocked.

### Known Limitations
- Real external provider and authenticated host canaries remain environment-specific release gates.

## [4.0.0] - 2026-07-26

### Added

- v3.1 role-minimized Context Delivery Runtime with provenance, redaction, byte/token budget, source freshness, stale-source policy, and verifier blind context
- v3.2 exact Model Registry and deterministic capability/risk/classification/cost/health Router
- immutable ModelObservation receipts for success, failure, latency, tokens, and cost without automatic policy mutation
- v3.3 versioned WorkContract and Handoff lifecycle
- v3.4 bounded Knowledge and Impact Graph
- v3.5 append-only Organization Memory with independent promotion and sensitivity-aware recall
- v4.0 Intelligence Fabric execution bundle and terminal verification gate
- authenticated REST/CLI/TUI projections for all six runtime areas
- read-only `pg4_*` MCP tools, including `pg4_model_observations`
- `--model-registry` and `PROOFGRAPH_MODEL_REGISTRY` configuration

### Changed

- Graph Port requests now carry exact model IDs and Intelligence bundle digests
- terminal quality gate now verifies Context, Route, Contract, Impact, Memory, and execution bundles
- package identity changed to `@proofgraph/intelligence`
- mission resume fails closed when the configured model registry differs from the persisted registry digest

### Security

- nested secret leaf-key redaction
- model registry symlink, size, schema, and digest checks
- self-only collaboration contracts and memory self-verification rejected
- bounded property graph traversal and memory payloads
- model-callable MCP surface remains read-only for operator authority

### Verification

- legacy Runtime/Operator regression suite preserved
- Intelligence unit, integration, adversarial, branch, CLI, MCP, REST, TUI, registry drift, source freshness, model observation, and tamper tests
- 174/174 automated tests and 97.02% / 76.96% / 93.00% line/branch/function coverage
- independent Intelligence black-box verifier without production runtime imports

### Known Limitations

- exact public v1.1 tree integration regression remains required
- authenticated multi-host and real-provider model routing canary remains required
- model calibration values must be measured in the target environment
- current memory retrieval is lexical plus graph-neighborhood, not a vector database

## [3.0.0] - 2026-07-26

### Added

- v2.0.1 normalized observability contract with explicit clean/recovery/denied states
- `route.changed`, `loop.*`, `node.progress`, retry, host, pause, and resume events
- v2.1 loopback Control Plane with REST, SSE, idempotent commands, approval service, and Host Registry
- v2.2 read-only real-time Operator TUI
- v2.3 pause, resume, retry, approve, deny, abort, and new-run actions
- v2.4 OpenCode HTTP/SSE client, bounded Observer plugin, and `/pg-*` command package
- v2.5 execution, organization, OS-cycle, timeline, and failure views with 1,000-node virtualization
- v3.0 `proofgraph start`, `proofgraphd`, snapshot, doctor, install-opencode, and stop commands

### Changed

- completion now distinguishes `completed_clean` and `completed_with_recovery`
- failures are split into historical, resolved, and unresolved sets
- operator UI no longer reads or writes runtime state files directly
- package identity changed to `@proofgraph/operator`

### Security

- separate operator and host-ingest tokens
- approval challenges remain server-side and are removed from projections, REST, SSE, and TUI
- loopback-only Control Plane by default
- idempotent, hash-chained operator command ledger
- terminal escape and control-character sanitization
- token symlink and broad POSIX permission rejection
- bounded HTTP body, SSE client, event, graph, and loop surfaces

### Verification

- 149/149 automated tests PASS
- 18/18 baseline CLI/MCP independent black-box PASS
- 15/15 Operator independent REST/SSE/CLI black-box PASS
- 95.69% line, 75.85% branch, 90.22% function coverage
- fake OpenCode HTTP/SSE and Host Bridge recovery-loop verification

### Known Limitations

- authenticated OpenCode live canary remains required
- exact Hermes v1.1.0 tree merge remains required
- distributed RBAC/TLS/database backend is not included

## [2.0.0] - 2026-07-25

### Added

- Governance Policy Engine
- evidence-aware Council Runtime
- durable queue with lease, heartbeat, idempotency, and stale recovery
- Ed25519-signed Organization/Policy package registry
- bounded Autonomous Organization OS cycle
- proposal-only Improvement Engine
- CLI and stdio MCP surface
- operator CLI for mission resume, integrity, abort, OS mission approval, and proposal-bound delivery

### Security

- model-callable MCP excludes approve, deny, abort, policy apply, and runtime modification
- autonomous cycles are finite
- self-improvement cannot directly mutate runtime or policy
- external delivery adapters require declared side-effect manifests and proposal-bound persisted approval before invocation
- per-data-directory CSPRNG approval secrets replace shipped fixed secrets
- state, event, and approval-secret symlink replacement fails closed
- governance inputs cannot disable external, policy-change, or runtime-change approval requirements
- oversized workspace, metadata, and OS control payloads are rejected before persistence
- OS run identity covers the complete validated mission input

### Verification

- unit, integration, adversarial, CLI, MCP, state-tamper, event-chain, signature, delegation, and lease tests
- 48 unit, 30 integration, and 31 adversarial tests: 109/109 PASS
- independent black-box verifier: 18/18 PASS without production runtime imports
- production coverage: 95.03% line, 78.06% branch (관측 최소값), 92.43% function
- preflight: 13 PASS, 0 FAIL, 4 explicit integration/live-canary SKIP

### Known Limitations

- exact integration with the Hermes-finalized v1.1.0 tree remains required
- live OpenCode, Pi, and Orca canaries are not performed by this offline build
- local hashes are not external signatures or notarization

## [1.4.0] - 2026-07-25

### Added

- Mission → Project → Sprint → WorkItem → Graph Run hierarchy
- bounded Company Runtime and failure rerouting
- explicit interrupted-work recovery
- Artifact Runtime and verified promotion gate
- Delivery Runtime and approval receipts
- v1.1 Host Bridge Graph Port

## [1.3.0] - 2026-07-25

### Added

- Organization, Department, Team, and Role domain model
- Executive Manager and dynamic Organization Builder
- independence groups and reporting-line validation
- capability registry, budget envelopes, and signed delegation tokens
- capability and budget attenuation

## [1.2.0] - 2026-07-25

### Added

- deterministic Task Intelligence Compiler
- bounded Workspace Discovery
- task archetype, complexity, uncertainty, risk, and reversibility classification
- deliverable and acceptance contracts
- Graph Blueprint and Adequacy Validator
