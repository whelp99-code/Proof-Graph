# ProofGraph Intelligence Fabric 코드 감사 및 개선 결과

작성일: 2026-07-26  
대상 기준선: ProofGraph Operator v3.0.0 + ProofGraph v1.1 Host 계약  
개선 결과: ProofGraph Intelligence v4.0.0

## 1. 감사 질문

다음 여섯 기능이 실제 코드에 독립 Runtime으로 존재하는지 확인했다.

1. 역할별 정확한 데이터 전달
2. 정확 모델 ID 기반 모델 라우팅
3. 계약 기반 협업
4. Knowledge Graph와 영향 분석
5. 조직 기억
6. 독립 검증

문서의 주장보다 실제 실행 경로, 상태 계약, 외부 API, 시험을 우선해 판정했다.

## 2. 개선 전 판정

| 영역 | 기존 상태 | 판정 | 한계 |
|---|---|---|---|
| Verification | 독립 Verifier, Artifact 승격, 실패 역라우팅, 승인 게이트 | 강함 | Context·Route·Contract·Memory 자체는 검증하지 않음 |
| Organization | Department·Team·Role·Capability·Delegation | 강함 | 역할별 Context·모델·협업 정책 연결이 약함 |
| Context Delivery | Mission·Task·Dependency 정보를 실행 요청에 포함 | 부분 | 역할 최소화, provenance, redaction, byte budget이 독립 계약이 아님 |
| Model Routing | `model_tier`, Host 선택, Adapter 계약 | 부분 | exact model registry, 적합성·비용·fallback·결정 영수증이 없음 |
| Collaboration | WorkItem dependency, 보고 체계, 역할 분리 | 부분 | 명시적 ACK/REJECT/BLOCKED/COMPLETED 계약이 없음 |
| Knowledge/Impact | 실행 DAG와 조직 그래프 | 없음 | 코드·API·파일·테스트·결정 간 영향 그래프가 없음 |
| Organization Memory | Run state, event log, report | 부분 | Mission 간 verified Decision/Lesson/Artifact recall이 없음 |

결론: Verification과 Organization은 재사용할 수 있었고, 나머지 다섯 계층은 보강 또는 신규 구현이 필요했다.

## 3. v4.0.0 구현 결과

| 영역 | 대표 구현 | 핵심 보장 |
|---|---|---|
| Context Delivery | `runtime/intelligence/context-runtime.mjs` | 역할별 allowlist, 최소 ContextPacket, provenance digest, redaction, byte/token bound, source freshness/staleness, verifier blind context |
| Model Routing | `model-router.mjs`, `registry-loader.mjs` | exact model ID, capability/risk/classification/context/cost/health gate, deterministic score, fallback, registry drift 차단, immutable execution observation |
| Collaboration | `collaboration-runtime.mjs` | versioned WorkContract/Handoff, ACK·REJECT·BLOCK·COMPLETE, self-only contract 차단, impact follow-up |
| Knowledge/Impact | `knowledge-graph.mjs` | bounded property graph, N-hop traversal, severity, provenance, duplicate/tamper 차단 |
| Organization Memory | `memory-runtime.mjs` | append-only hash-chain, proposed/verified/superseded/rejected, 독립 승격, sensitivity-aware recall |
| Intelligence Verification | `verification-runtime.mjs` | Context·Route·Contract·Handoff·Impact·Memory·Terminal gate 검증 |
| Integration | `fabric.mjs`, `company-runtime.mjs` | 실행 전 bundle 준비, 보고 후 Knowledge/Contract/Memory 반영, terminal 전 통합 검증 |
| Operator | Control Plane, CLI, MCP, TUI | 여섯 Runtime을 별도 View와 인증 API로 조회 |

## 4. 발견하여 수정한 실제 결함

1. 중첩 객체의 `password` 키가 전체 경로 문자열 때문에 redaction을 우회할 수 있었다. leaf-key 기준으로 수정했다.
2. `null` model registry가 기본 registry가 아니라 잘못된 입력으로 해석되던 호환성 결함을 수정했다.
3. normalized registry를 다시 전달할 때 `digest`를 unknown key로 거부하던 결함을 수정하고 digest를 검증하도록 변경했다.
4. Mission을 다른 model registry로 재개할 수 있던 drift 가능성을 실행 전에 차단했다.
5. Memory 검색 점수 같은 조회 메타데이터가 원본 digest를 깨뜨리는 것으로 오판되던 결함을 수정했다.
6. 정보 제공용 topology impact가 필수 후속 작업으로 오판되던 문제를 `action_required`로 분리했다.
7. daemon 종료와 시험 디렉터리 정리의 경쟁 조건을 보강했다.
8. source 시점이 없는 데이터와 오래된 데이터를 구분하고, stale source를 정책에 따라 fail-closed하도록 보강했다.
9. 모델 실행 성공·실패·지연·토큰·비용을 관측 증거로 저장하되 관측이 Registry 정책을 자동 변경하지 못하게 분리했다.
10. 분기 Coverage가 75% 미만으로 떨어진 문제를 기준 완화 없이 sparse/rich projection, 모델 실패, 계약 lifecycle, memory lifecycle 시험으로 보강했다.

## 5. 검증 범위

- 기존 Runtime·Operator 회귀
- Intelligence unit/integration/adversarial
- exact model registry CLI 실행
- registry drift·symlink 공격
- stdio MCP의 읽기 전용 `pg4_*` 도구
- 인증 REST 상세 조회
- TUI Context/Models/Collaboration/Knowledge/Memory/Verification 화면
- source freshness/staleness와 model execution observation 외부 조회
- 상태·event·Intelligence digest 변조
- 독립 블랙박스 검증은 production Runtime 모듈을 import하지 않음

## 6. 남은 실환경 게이트

- 공개 v1.1.0 exact tree와 통합 회귀
- 인증된 OpenCode·Pi·Claude 등 실제 Host/모델 조합 canary
- 실제 비용·latency·quality 계측에 따른 registry calibration
- 팀 RBAC, TLS, 분산 저장과 중앙 관측

이 항목들은 코드 미구현과 구분해 `live/integration gate`로 남긴다.
