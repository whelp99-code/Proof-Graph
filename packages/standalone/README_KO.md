# ProofGraph Standalone v5.0.0

ProofGraph v5는 시뮬레이션과 실제 실행을 분리하고, OpenAI-compatible 모델·Host Bridge·Sandbox Tool Runtime을 통해 실제 AI 조직 작업을 수행하는 독립 실행형 GA Candidate입니다.

- 시뮬레이션: `proofgraph simulate --new "목표"`
- 로컬 모델: `proofgraph start --provider-url http://127.0.0.1:11434/v1 --provider-model <model> --native-local --new "목표"`
- 외부 Host: `proofgraph start --bridge-url http://127.0.0.1:8743 --bridge-token <token> --runtime-host opencode --new "목표"`

> 실제 외부 Provider·Host canary 전까지 릴리스 게이트는 `PASS_OFFLINE_LIVE_PROVIDER_AND_HOST_CANARY_REQUIRED`입니다.

자세한 내용: `docs/STANDALONE_EXECUTION_KO.md`

---

# ProofGraph Intelligence v4.0.0

ProofGraph Intelligence는 여러 AI Agent를 조직으로 운영하면서 **정확한 Context 전달, exact AI 모델 라우팅, 계약 기반 협업, Knowledge Graph 영향 분석, 조직 기억, 독립 검증**을 하나의 Runtime으로 결합한 Graph Operations 플랫폼입니다.

```text
사용자 목표
  → Task / Organization Compiler
  → Mission Graph
  → Knowledge Impact + Verified Memory
  → Role-minimized ContextPacket
  → Exact Model RouteDecision
  → WorkContract / HandoffPacket
  → OpenCode·Pi·Claude·Orca Host 실행
  → Model Observation + Report Ingestion
  → Independent Verification
  → Artifact 승격 또는 Failure Reroute
  → Operator TUI
```

## 현재 릴리스 상태

```text
Intelligence Fabric 구현:             COMPLETE_OFFLINE
전체 자동 시험:                       174/174 PASS
Coverage:                              97.02 / 76.96 / 93.00
기존 CLI·MCP 독립 블랙박스:           18/18 PASS
Operator REST·SSE·CLI 독립 검증:       15/15 PASS
Intelligence 독립 블랙박스:            11/11 PASS
Preflight:                              13 PASS / 0 FAIL / 2 SKIP
실제 다중 Host·모델 canary:            REQUIRED
공개 v1.1 exact-tree 통합 회귀:        REQUIRED
릴리스 게이트:
PASS_OFFLINE_V1_1_INTEGRATION_AND_MULTI_MODEL_CANARY_REQUIRED
```

두 Skip은 실제 OpenCode·Pi·Claude·Orca 인증 실행과 공개 v1.1.0 exact tree 통합입니다. 실행하지 않은 항목을 PASS로 계산하지 않습니다.

## 여섯 Runtime

### 1. Context Delivery

각 역할은 전체 Mission이 아니라 필요한 섹션만 받습니다. `ContextPacket`에는 provenance digest, byte/token budget, redaction, dropped section, source freshness가 기록됩니다.

- secret-like leaf key와 알려진 key/value 패턴 마스킹
- Verifier blind context
- `observed_at`, `source_updated_at`, `age_seconds`, `freshness`
- stale source 표시 또는 정책 기반 fail-closed 거부

### 2. Model Routing

`ModelRegistry`의 exact `model_id`, capability, risk ceiling, data classification, context limit, cost, health를 평가해 결정적인 `RouteDecision`과 fallback chain을 남깁니다.

실행 후에는 `ModelObservation`으로 성공·실패·지연·토큰·비용을 축적합니다. **관측 데이터는 증거이며, 라우팅 정책을 자동 변경하지 않습니다.** 운영자가 canary와 평가를 거쳐 Registry를 명시적으로 갱신해야 합니다.

### 3. Collaboration

Agent 간 자유형 메시지 대신 versioned `WorkContract`와 `HandoffPacket`을 사용합니다. `ACKNOWLEDGED`, `REJECTED`, `BLOCKED`, `COMPLETED`, `CANCELLED` 상태가 모두 감사 원장에 남고 열린 계약은 terminal quality gate를 통과하지 못합니다.

### 4. Knowledge & Impact

Task, Requirement, Role, WorkItem, Artifact, File, API, Service, Test, Decision의 관계를 bounded property graph로 유지합니다. N-hop 영향도를 계산하고 `informational`과 `action_required`를 구분하여 QA·Security·Documentation 후속 계약을 생성합니다.

### 5. Organization Memory

검증된 Decision, Constraint, Artifact, Lesson, Failure, Verification을 Mission 간 재사용합니다. 검증되지 않은 추론은 `proposed`로 남고 factual context로 자동 승격되지 않습니다.

### 6. Intelligence Verification

기존 결과 검증에 더해 Context, Route, ModelObservation, Contract, Handoff, Impact, Memory provenance와 terminal coverage를 검사합니다.

## 설치와 검증

```bash
npm ci --ignore-scripts
npm test
npm run coverage
npm run preflight
npm run verify:independent
npm run verify:operator
npm run verify:intelligence
npm run build:manifest
npm run verify:package
npm link
```

Node.js 20 이상이 필요합니다.

## 가장 간단한 실행

기본 offline reference registry:

```bash
proofgraph start --new   "인증 API를 구현하고 보안 및 회귀 테스트로 독립 검증하라"
```

실제 exact 모델 Registry 지정:

```bash
cp examples/model-registry.example.json ./model-registry.json
# 실제 exact model ID, 검증된 capability, cost, context limit을 입력하고 필요한 entry만 enabled=true

proofgraph start   --model-registry ./model-registry.json   --new "인증 API를 구현하고 독립 검증하라"
```

환경변수:

```bash
export PROOFGRAPH_MODEL_REGISTRY=/absolute/path/model-registry.json
```

Mission 재개에는 생성 시 사용한 Registry digest가 필요합니다. 다른 Registry를 사용하면 fail-closed합니다.

## TUI View

| 키 | 화면 |
|---|---|
| `G` | 실행 Graph와 Loop |
| `O` | 조직 Graph |
| `E` | Context 전달량·redaction·source freshness |
| `M` | exact model 선택·fallback·실행 관측 |
| `B` | WorkContract·Handoff 상태 |
| `W` | Knowledge/Impact |
| `Y` | Organization Memory |
| `V` | Intelligence Verification |
| `T` | Timeline |
| `F` | Failure Center |
| `I` | Artifact |

## CLI 조회

```bash
proofgraph status
proofgraph intelligence <run_id> intelligence
proofgraph intelligence <run_id> context --full
proofgraph intelligence <run_id> routes --full
proofgraph intelligence <run_id> model-observations --full
proofgraph intelligence <run_id> contracts --full
proofgraph intelligence <run_id> knowledge --full
proofgraph intelligence <run_id> memory --full
proofgraph intelligence <run_id> verification --full
```

Organization CLI:

```bash
proofgraph-org mission-intelligence <mission_id> summary
proofgraph-org mission-intelligence <mission_id> contexts --full
proofgraph-org mission-intelligence <mission_id> routes
proofgraph-org mission-intelligence <mission_id> observations
proofgraph-org mission-intelligence <mission_id> contracts
proofgraph-org mission-intelligence <mission_id> knowledge --full
proofgraph-org mission-intelligence <mission_id> memory --full
proofgraph-org mission-intelligence <mission_id> verification
proofgraph-org mission-impact <mission_id> <source_id> --depth 2
```

## MCP

기존 `pg2_*` 실행 도구를 유지하면서 다음 읽기 전용 도구를 제공합니다.

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

`pg4_*` 표면에는 approve, deny, abort, policy mutation 도구가 없습니다.

## 문서

- [코드 감사와 개선 결과](./CODE_AUDIT_INTELLIGENCE_FABRIC_KO.md)
- [단계별 개발 계획](./DEVELOPMENT_PLAN_INTELLIGENCE_FABRIC_V3_1_TO_V4_0_KO.md)
- [Intelligence Fabric](./docs/INTELLIGENCE_FABRIC_KO.md)
- [Context Delivery](./docs/CONTEXT_DELIVERY_KO.md)
- [Model Routing](./docs/MODEL_ROUTING_KO.md)
- [Collaboration Contract](./docs/COLLABORATION_CONTRACTS_KO.md)
- [Knowledge & Memory](./docs/KNOWLEDGE_MEMORY_KO.md)
- [추적성 매트릭스](./docs/TRACEABILITY_MATRIX_KO.md)
- [검증 보고서](./verification/VERIFICATION_REPORT_KO.md)
- [알려진 제한](./docs/LIMITATIONS_KO.md)

## 중요한 경계

- 모델 Registry 값은 실환경 canary와 평가로 교정해야 하며, 예제 수치를 공급자 성능 주장으로 사용할 수 없습니다.
- ModelObservation은 정책 자동 변경이 아니라 감사·평가 증거입니다.
- Source freshness는 시점과 노후도를 표시하지만 원 데이터의 의미적 진실성을 보증하지 않습니다.
- Knowledge impact는 후속 검토 범위를 계산하며 직접 파일 변경 권한을 부여하지 않습니다.
- Memory 검색은 현재 bounded lexical+graph 방식입니다.
- OpenCode 작업 완료와 ProofGraph 검증 완료는 별개입니다.
- 외부 부작용, 승인, 거절, 중단은 계속 외부 Operator 권한입니다.
