# ProofGraph × Orca Integration

ProofGraph v1.0.2 includes an **Orca execution-host compatibility bridge**. ProofGraph remains the authority for GraphSpec, routing, verification, and final state; Orca owns agent terminals and Git worktrees.

## Node lifecycle

```text
ProofGraph ready node
  -> Orca task-create
  -> Orca worktree create with an allowlisted agent
  -> terminal wait
  -> orchestration dispatch --inject
  -> orchestration check --all --wait
  -> matching taskId + dispatchId worker_done
  -> exact JSON report inside the worktree
  -> ProofGraph verification and routing
```

Terminal idle and heartbeat never count as completion. Stale dispatch completions, duplicate `worker_done`, report-path mismatch, traversal, symlink reports, and non-allowlisted agents fail closed.

## Required Orca settings

1. Register the Orca CLI under Settings → Experimental → CLI.
2. Enable Experimental → Orchestration.
3. Set Settings → Agents → Agent Permissions to **Manual**.
4. Run `orca repo list --json` and set an explicit `repo_selector` such as `id:<repoId>`.
5. Pin the Orca version used by the live canary.
6. Keep ProofGraph Workspace Engine disabled; Orca must be the sole worktree owner.

Run the read-only preflight:

```bash
npm run orca:preflight -- --manual-confirmed --output verification/orca-live-preflight.json
```

Use `examples/orca-bridge.config.json` as the safe starting configuration.

## Boundary

This is not strict Orca-native mode. `.proofgraph` still stores graph state. Local absolute worktree paths are required, so SSH worktrees and Remote Orca Servers are not yet supported. Workspace mutation remains disabled until a supervised live canary passes.

See `docs/ORCA_INTEGRATION_KO.md` for the complete Korean operations and threat-model guide.
