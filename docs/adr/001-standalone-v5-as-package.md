# ADR-001: ProofGraph Standalone v5.0.0 as Monorepo Package

## Status
Accepted (2026-07-26)

## Context
ProofGraph v1.1.0 (GitHub `whelp99-code/Proof-Graph`, commit `6928a96`) is the authoritative Graph Kernel baseline — hosting GraphSpec, routing, verification, approval, workspace policy, and OpenCode/Pi host integrations. ProofGraph Standalone v5.0.0 (`@proofgraph/standalone`) is a cumulative extension adding task intelligence, organization engineering, company runtime, operator TUI, control-plane server, native model gateway, and collaboration fabric.

The integration manifest specifies `integration_strategy: workspace-package-over-v1.1-host`. Intermediate v2/v3/v4 packages are not merged individually; v5.0.0 is the single cumulative payload.

## Decision
1. **v5 lives at `packages/standalone/`** inside the Proof-Graph monorepo. This preserves v1.1's root-level Graph Kernel authority and lets v5 export independently.
2. **v1.1 root `runtime/` is untouched.** No file in the existing `runtime/` directory is modified by this integration. v5 ships its own `runtime/` inside `packages/standalone/`.
3. **Root `package.json` remains the Graph Kernel manifest.** It is extended with a `workspaces: ["packages/standalone"]` field and no other change.
4. **v5 connects via `v1-1-port.mjs` bridge** (already present in v5 at `runtime/integration/v1-1-port.mjs`). The bridge enforces:
   - v1.1 remains authoritative for GraphSpec, routing, verification, approval, workspace policy, and terminal state.
   - Model-callable Host tools cannot acquire operator-only commands (`approve`, `deny`, `abort`).
   - Remote bridges require HTTPS; loopback HTTP requires a bearer token.
5. **Root `bin/proofgraph.mjs` is v1.1's CLI.** v5's CLI is accessible via `npx proofgraph-standalone ...` or `node packages/standalone/bin/proofgraph.mjs`.
6. **Test suites remain separate.** v1.1 tests at root `tests/`; v5 tests at `packages/standalone/tests/`. On CI both are run.
7. **Documentation is merged at root level.** v5 README, CHANGELOG, integration docs, and limitation docs are placed at `packages/standalone/docs/`. Root-level `README.md` and `README_KO.md` are updated to reference the v5 package.

## Consequences
- **Positive**: v1.1 Graph Kernel is never destabilized by v5 changes. Clean separation for CI and test isolation. v5 can be released independently as `@proofgraph/standalone` if needed.
- **Negative**: No runtime sharing between root and v5 code (duplicated infrastructure). Users must explicitly invoke v5 binaries.
- **Mitigation**: The `v1-1-port.mjs` bridge and `INTEGRATION_MANIFEST.json` provide the contract for v5 to defer to v1.1 for authoritative operations.

## Related
- INTEGRATION_MANIFEST.json (v5.0.0): `integration_strategy: workspace-package-over-v1.1-host`
- `runtime/integration/v1-1-port.mjs`: Bridge contract
- PR #4 (this integration)
