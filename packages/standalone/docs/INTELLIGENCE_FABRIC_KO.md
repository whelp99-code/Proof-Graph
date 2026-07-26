# ProofGraph Intelligence Fabric v4.0.0

## 제품 정의

Intelligence Fabric은 조직 화면 아래에서 데이터 전달, 모델 선택, 협업, 영향 분석, 기억, 검증을 하나의 실행 계약으로 묶는 계층이다.

```text
WorkItem Ready
  → Knowledge neighborhood / Impact
  → Verified Memory recall
  → Role-minimized ContextPacket + source freshness
  → Exact Model RouteDecision
  → WorkContract / HandoffPacket
  → Host execution
  → immutable ModelObservation
  → Report ingestion
  → Knowledge / Contract / Memory update
  → Intelligence Verification
  → Artifact promotion or Failure reroute
```

## 실행 전 Bundle

```text
ContextPacket
RouteDecision
WorkContracts
HandoffPackets
ImpactSet
MemoryRefs
Bundle digest
```

Graph Port는 bundle과 exact `model_id`를 Host에 전달한다. 모든 구성요소는 ID와 digest를 가지며, Host가 임의 모델을 사용하거나 bundle을 변경한 사실은 보고서와 verifier가 탐지하도록 설계했다.

## 실행 후 증거

```text
Agent report
ModelObservation
Knowledge relation update
Contract acknowledgement/completion
Memory proposal/verification
Intelligence verification result
```

모델 관측은 정책 자동 변경에 사용되지 않는다. 정책 변경은 별도 버전의 ModelRegistry로만 가능하다.

## 권위 경계

| 권위 | 담당 |
|---|---|
| Ready Node와 Failure Route | ProofGraph Company/Graph Runtime |
| Context 최소화·마스킹·freshness | Context Runtime |
| Model eligibility·선택 | Model Router |
| 실행 결과 계측 | ModelObservation ledger |
| 협업 상태 | Collaboration Runtime |
| 영향 관계 | Knowledge Graph |
| 검증된 기억 | Organization Memory |
| 최종 승격 | Verification + Artifact Runtime |
| 승인·거절·중단 | 외부 Operator |
| 실제 모델·도구 실행 | OpenCode/Pi/Claude/Orca Host |

Host나 모델은 승인·거절·abort 권한을 암묵적으로 얻지 않는다.

## 저장과 조회

Mission state에는 bounded Intelligence projection이 포함되고, 조직 기억은 별도 append-only HashChainStore에 저장된다. TUI와 외부 클라이언트는 파일을 직접 수정하지 않고 Control Plane API를 사용한다.

```bash
proofgraph intelligence <run_id> intelligence
proofgraph intelligence <run_id> context --full
proofgraph intelligence <run_id> routes --full
proofgraph intelligence <run_id> model-observations --full
proofgraph intelligence <run_id> contracts --full
proofgraph intelligence <run_id> knowledge --full
proofgraph intelligence <run_id> memory --full
proofgraph intelligence <run_id> verification --full
```

TUI:

```text
E Context
M Models + Observations
B Collaboration
W Knowledge/Impact
Y Memory
V Intelligence Verification
```
