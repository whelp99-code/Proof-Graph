# ProofGraph Standalone v5.0.0

ProofGraph v5는 시뮬레이션과 실제 실행을 분리하고, OpenAI-compatible 모델·Host Bridge·Sandbox Tool Runtime을 통해 실제 AI 조직 작업을 수행하는 독립 실행형 GA Candidate입니다.

- 시뮬레이션: `proofgraph simulate --new "목표"`
- 로컬 모델: `proofgraph start --provider-url http://127.0.0.1:11434/v1 --provider-model <model> --native-local --new "목표"`
- 외부 Host: `proofgraph start --bridge-url http://127.0.0.1:8743 --bridge-token <token> --runtime-host opencode --new "목표"`

> 실제 외부 Provider·Host canary 전까지 릴리스 게이트는 `PASS_OFFLINE_LIVE_PROVIDER_AND_HOST_CANARY_REQUIRED`입니다.

자세한 내용: `docs/STANDALONE_EXECUTION_KO.md`

---

# ProofGraph Intelligence v4.0.0

ProofGraph Intelligence is a graph operations runtime for AI organizations. It combines role-minimized context delivery, exact model routing, contract-based collaboration, bounded knowledge impact analysis, organization memory, immutable model execution observations, and independent verification.

```text
Goal → Task/Organization → Mission Graph
     → Impact + Verified Memory
     → ContextPacket → RouteDecision → WorkContract
     → Host execution → ModelObservation → Verification
     → Artifact promotion / Failure route → Operator TUI
```

## Release evidence

```text
Automated tests:                       174/174 PASS
Coverage line / branch / function:     97.02 / 76.96 / 93.00
Independent CLI/MCP:                    18/18 PASS
Independent Operator REST/SSE/CLI:      15/15 PASS
Independent Intelligence black-box:     11/11 PASS
Preflight:                              13 PASS / 0 FAIL / 2 SKIP
Authenticated multi-host/model canary:  REQUIRED
Exact public v1.1 tree integration:     REQUIRED
PASS_OFFLINE_V1_1_INTEGRATION_AND_MULTI_MODEL_CANARY_REQUIRED
```

The two skipped gates are not counted as passes.

## Quick start

```bash
npm ci --ignore-scripts
npm test
npm run coverage
npm run verify:intelligence
npm link

proofgraph start --new   "Implement an authentication API and independently verify security and regression"
```

Use an exact model registry:

```bash
proofgraph start   --model-registry ./model-registry.json   --new "Implement and verify a bounded API"
```

The example registry is disabled by default. Replace placeholder IDs and calibration values with measured host configuration before enabling entries. Model observations record outcomes, latency, tokens, and cost, but never silently rewrite routing policy.

## Operator views

- `G`: execution graph and loops
- `E`: context delivery and source freshness
- `M`: exact model routes, fallback, and observations
- `B`: collaboration contracts and handoffs
- `W`: knowledge and impact
- `Y`: organization memory
- `V`: intelligence verification

## Read-only MCP surface

```text
pg4_intelligence_status
pg4_context
pg4_model_routes
pg4_model_observations
pg4_contracts
pg4_impact
pg4_memory
pg4_intelligence_verification
```

No pg4 model-callable tool can approve, deny, abort, or mutate runtime policy.

See the [Korean README](./README_KO.md), [code audit](./CODE_AUDIT_INTELLIGENCE_FABRIC_KO.md), [Intelligence Fabric design](./docs/INTELLIGENCE_FABRIC_KO.md), [verification report](./verification/VERIFICATION_REPORT_KO.md), and [development plan](./DEVELOPMENT_PLAN_INTELLIGENCE_FABRIC_V3_1_TO_V4_0_KO.md).
