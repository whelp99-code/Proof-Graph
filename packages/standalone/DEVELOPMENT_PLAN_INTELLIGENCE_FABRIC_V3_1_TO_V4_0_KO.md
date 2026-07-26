# ProofGraph Intelligence Fabric v3.1 → v4.0 개발 계획

작성일: 2026-07-26  
기준선: ProofGraph Operator v3.0.0 + 공개 ProofGraph v1.1.0 Host Runtime  
최종 목표: Context·Model Routing·Collaboration·Knowledge·Memory·Verification을 하나의 증거 기반 실행 계층으로 통합

## 0. 구현 완료 상태

```text
v3.1 Context Delivery Runtime:       COMPLETE_OFFLINE
v3.2 Model Routing Runtime:          COMPLETE_OFFLINE
v3.3 Collaboration Contract Runtime: COMPLETE_OFFLINE
v3.4 Knowledge & Impact Graph:       COMPLETE_OFFLINE
v3.5 Organization Memory Runtime:    COMPLETE_OFFLINE
v4.0 Intelligence Fabric:            COMPLETE_OFFLINE
독립 multi-model/Host canary:         REQUIRED
공개 v1.1 exact-tree 통합:            REQUIRED
```

대표 구현은 `runtime/intelligence/`와 `CompanyRuntime`, Control Plane, CLI, MCP, Operator TUI에 반영됐다. 상세 감사는 `CODE_AUDIT_INTELLIGENCE_FABRIC_KO.md`를 참조한다.

## 1. 코드 감사 결론

| 영역 | 기존 구현 | 판정 | 핵심 근거 | v4 목표 |
|---|---|---|---|---|
| Verification Runtime | 독립 verifier, artifact promotion, integrity, failure rerouting | 강함 | `company-runtime.mjs`, `artifact-runtime.mjs`, v1.1 Graph verifier | 다른 Intelligence 결과까지 검증 범위 확대 |
| Organization Runtime | 부서·팀·역할·capability·delegation | 강함 | `organization/builders.mjs`, `delegation.mjs` | 협업 계약과 모델/Context 정책을 역할에 연결 |
| Artifact Runtime | 후보/검증/Delivery gate | 강함 | `artifact-runtime.mjs`, `delivery-runtime.mjs` | Knowledge·Memory·Contract의 provenance source로 사용 |
| Context Delivery | Task/Organization 전체 객체를 Node에 전달 | 부분 | `company-runtime.mjs` request 생성 | 역할별 최소 ContextPacket, provenance, redaction, 예산 |
| Model Routing | Graph의 tier/Host 선택 단서만 존재 | 부분 | v1.1 `model_tier`, v3 Host Registry | exact model registry, eligibility, score, fallback, route receipt |
| Collaboration | WorkItem dependency와 역할 분리 | 부분 | Mission work item DAG, reporting lines | typed WorkContract, handoff, ACK/REJECT, 영향 기반 follow-up |
| Knowledge Graph | 실행 DAG/조직 그래프만 존재 | 없음 | 코드·업무 관계용 property graph 없음 | entity/relation graph, impact traversal, coverage gate |
| Organization Memory | Mission state/event/audit는 존재 | 부분 | append-only run state와 report | Mission 간 Decision/Lesson/Artifact memory, provenance retrieval |

## 2. 제품 불변조건

1. Context는 역할과 작업에 필요한 최소 데이터만 전달하며 secret-like 필드는 기본 redaction한다.
2. 모든 ContextPacket은 source reference와 digest를 가진다.
3. 모델 라우팅은 exact model ID, registry version, 선택 사유, 대안, fallback을 기록한다.
4. Model/Host는 operator approval 권한을 획득하지 않는다.
5. 협업은 자유형 메시지가 아니라 versioned WorkContract와 HandoffPacket으로 수행한다.
6. 계약은 ACK, REJECT, COMPLETED, BLOCKED 중 하나의 상태를 가져야 하며 조용히 유실되지 않는다.
7. Knowledge Graph의 외부 입력은 명령이 아니라 데이터로 취급한다.
8. 영향 분석으로 생성된 후속 작업은 유한 개수와 허용 역할을 벗어나지 않는다.
9. Memory는 검증된 산출물·명시적 결정·해결된 실패만 자동 승격하며 추론은 proposal 상태로 남긴다.
10. Verification은 결과뿐 아니라 Context, Route, Contract, Impact Coverage, Memory provenance를 검사한다.
11. 기존 v3 Operator와 v1.1 Host Bridge 경계를 우회하지 않는다.
12. 모든 추가 데이터 구조에는 schema version과 size/count bound를 둔다.

## 3. 단계별 개발

### v3.1.0 — Context Delivery Runtime

- `ContextPolicy`와 역할별 allowlist
- `ContextPacket v1`
- dependency output, verified artifact, accepted contract, memory recall을 입력으로 조합
- byte/token 추정 예산과 결정론적 truncation
- secret/path/credential redaction
- source provenance, as-of, staleness, digest
- verifier용 blind context: producer의 자기평가 설명 제외

완료 기준:
- 역할별 packet 차등
- secret 유출 0
- source 없는 factual entry 0
- packet digest tamper 탐지

### v3.2.0 — Model Routing Runtime

- `ModelRegistry v1`
- capability, modality, context limit, risk ceiling, cost, latency, quality, health
- `RouteRequest v1`와 `RouteDecision v1`
- deterministic eligibility + weighted score
- exact model ID와 fallback chain
- budget/risk/data classification gate
- execution observation으로 health snapshot 갱신

완료 기준:
- 부적합 모델 선택 0
- critical 작업의 low-trust route 0
- no eligible model은 fail-closed
- 동일 registry/input은 동일 decision

### v3.3.0 — Collaboration Contract Runtime

- `WorkContract v1`
- `HandoffPacket v1`
- producer/consumer, input/output contract, acceptance, evidence requirement
- ACK/REJECT/BLOCKED/COMPLETED lifecycle
- dependency 완료 시 contract 생성
- API/file/schema 변경 시 QA·Security·Docs follow-up contract 생성
- duplicate/idempotency key

완료 기준:
- silent handoff 0
- consumer 없는 contract 0
- 미충족 acceptance를 완료 처리 0
- verifier가 producer contract를 자기 승인하지 못함

### v3.4.0 — Knowledge & Impact Graph

- bounded property graph
- Entity: Task, Requirement, Role, WorkItem, Artifact, File, API, Service, Test, Decision
- Relation: depends_on, produces, consumes, modifies, verifies, impacts, decided_by
- artifact/report relation ingestion
- N-hop impact analysis
- impact severity와 required follow-up mapping
- graph digest와 provenance

완료 기준:
- duplicate node/edge 정규화
- traversal bound 준수
- 영향을 받은 critical entity의 검증 누락 탐지
- malicious graph field/prototype key 거부

### v3.5.0 — Organization Memory Runtime

- append-only `MemoryEntry v1`
- kind: decision, constraint, artifact, lesson, failure, verification, preference
- status: proposed, verified, superseded, rejected
- mission/project/task/knowledge links
- lexical + graph-neighborhood retrieval
- role/context policy 기반 recall
- verified artifact와 resolved failure의 자동 capture
- proposal-only inference

완료 기준:
- unverified memory의 factual context 승격 0
- superseded memory 우선순위 역전 0
- provenance 없는 memory 0
- cross-mission recall 재현 가능

### v4.0.0 — Intelligence Fabric Integration

- `IntelligenceFabric` orchestration
- CompanyRuntime claim 전 `prepareExecution`
- role-specific ContextPacket + Model Route + Contract bundle을 Graph Port에 전달
- report 완료 후 Knowledge/Contract/Memory 갱신
- terminal reconciliation 전 Intelligence Verification Gate
- Operator projection/TUI에 Context, Route, Collaboration, Knowledge, Memory view 추가
- REST/MCP/CLI 조회 표면 추가

완료 기준:
- 기존 149개 회귀 유지
- 신규 unit/integration/adversarial/black-box PASS
- Context/Route/Contract/Knowledge/Memory tamper 모두 fail-closed
- 기존 Host Bridge와 Reference Kernel 호환
- reproducible ZIP/TGZ 생성

## 4. 데이터 흐름

```text
WorkItem Ready
  → Impact Graph neighborhood
  → Memory retrieval
  → Context Compiler
  → Model Router
  → Collaboration Contract bundle
  → Host/Graph Port execution
  → Report integrity
  → Knowledge ingestion
  → Contract lifecycle update
  → Memory capture proposal
  → Intelligence Verification
  → Artifact promotion / Failure reroute
```

## 5. TUI 최종 화면

- Graph: 실행 경로와 loop
- Context: 전달된 섹션, bytes, redaction, source count
- Routing: provider/model, score, 이유, fallback, health
- Collaboration: pending/accepted/rejected contracts와 handoff
- Knowledge: 선택 Node의 영향 subgraph
- Memory: recall된 decision/lesson/artifact와 provenance
- Verification: 기존 결과 + Intelligence gate 결과

## 6. 검증 계획

### Unit
- Context policy/redaction/budget/digest
- Model eligibility/scoring/fallback
- Contract lifecycle/idempotency
- Knowledge ingest/traversal/impact
- Memory promotion/retrieval/supersession
- Intelligence gate

### Integration
- Task → Org → Mission → Context → Route → Host → Knowledge → Memory
- verification failure → contract/knowledge/memory 일관성
- second mission recalls verified first-mission memory
- TUI projection and REST/MCP output

### Adversarial
- secret injection and redaction bypass
- context provenance forgery
- model registry downgrade/route tamper
- capability/risk bypass
- contract self-approval and replay
- impact graph explosion/prototype pollution
- unverified memory promotion
- stale/superseded memory selection
- verifier bypass through Intelligence metadata

### Independent black-box
- CLI/MCP/REST only
- context/model/contract/impact/memory query
- deliberate state/report tampering
- process restart and deterministic retrieval

## 7. 출시 판정

`PASS_OFFLINE_V1_1_INTEGRATION_AND_MULTI_MODEL_CANARY_REQUIRED`

다음은 별도 live gate다.
- Hermes v1.1 exact-tree 통합
- authenticated OpenCode/Pi canary
- real provider model routing cost/latency calibration
