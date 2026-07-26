# ProofGraph Intelligence v4.0.0 오프라인 검증 보고서

검증일: 2026-07-26

## 1. 최종 판정

```text
Context Delivery Runtime:               COMPLETE_OFFLINE
Exact Model Routing Runtime:            COMPLETE_OFFLINE
Collaboration Contract Runtime:         COMPLETE_OFFLINE
Knowledge & Impact Runtime:             COMPLETE_OFFLINE
Organization Memory Runtime:            COMPLETE_OFFLINE
Intelligence Verification Runtime:      COMPLETE_OFFLINE
Operator TUI/REST/MCP integration:      COMPLETE_OFFLINE
전체 자동·독립 검증:                    PASS
실제 다중 Host·모델 canary:             REQUIRED
공개 v1.1 exact-tree 통합:              REQUIRED
릴리스 게이트:
PASS_OFFLINE_V1_1_INTEGRATION_AND_MULTI_MODEL_CANARY_REQUIRED
```

## 2. 개발 전 감사와 계획

개발 전에 `CODE_AUDIT_INTELLIGENCE_FABRIC_KO.md`로 기존 구현을 감사하고, `DEVELOPMENT_PLAN_INTELLIGENCE_FABRIC_V3_1_TO_V4_0_KO.md`에서 v3.1 Context → v3.2 Model → v3.3 Collaboration → v3.4 Knowledge → v3.5 Memory → v4.0 통합 순서를 고정했다.

기존에 강했던 Verification·Organization·Artifact·Graph 상태를 재사용하고, 약하거나 없던 다섯 계층을 독립 Runtime으로 구현했다.

## 3. 자동 시험

```text
전체 시험: 174/174 PASS
실패:      0
Skip:      0
```

시험은 기존 Graph/Organization/OS/Operator 회귀와 새 Intelligence unit·integration·adversarial·branch·CLI·MCP·REST·TUI 검증을 함께 수행한다.

## 4. Coverage

프로덕션 범위:

```text
runtime/**/*.mjs
bin/*.mjs
```

| 항목 | 결과 | 게이트 |
|---|---:|---:|
| Line | **97.02%** | 90% |
| Branch | **76.96%** | 75% |
| Function | **93.00%** | 90% |

초기 Branch 71.54% 결과에서 기준을 낮추지 않고 분기 시험을 추가해 게이트를 통과했다.

## 5. 독립 블랙박스

| 검증기 | 결과 | Production module import |
|---|---:|---:|
| 기존 CLI/MCP | **18/18 PASS** | 0 |
| Operator REST/SSE/CLI | **15/15 PASS** | 0 |
| Intelligence CLI/MCP/REST/TUI | **11/11 PASS** | 0 |
| **합계** | **44/44 PASS** | **0** |

Intelligence 검증기는 다음 외부 표면만 사용했다.

- `proofgraph-org` CLI subprocess
- `proofgraph` CLI와 `proofgraphd`
- stdio MCP initialize/tools/list/tools/call
- authenticated HTTP REST
- TUI snapshot
- model registry file와 registry drift
- state 파일 의도적 변조

## 6. Preflight

```text
13 PASS
0 FAIL
2 SKIP
```

Skip:

1. 인증된 OpenCode·Pi·Claude·Orca와 실제 모델의 cost/latency/quality canary
2. 공개 v1.1.0 exact-tree 통합 회귀

Skip은 PASS로 계산하지 않았다.

## 7. 성능

Node.js 22 / Linux x64 로컬 Projection·Render:

| Case | P50 | P95 | 게이트 |
|---|---:|---:|---:|
| 1,000-node graph | 0.246 ms | **0.415 ms** | < 2,000 ms |
| 1,000 nodes + 10,000 events snapshot | 0.360 ms | **0.559 ms** | < 2,000 ms |
| 10,000-event search | 7.151 ms | **7.543 ms** | < 1,000 ms |

모델 및 네트워크 지연은 포함하지 않는다.

## 8. 구현 중 발견·수정한 결함

1. nested `password` leaf key redaction 우회
2. null/default model registry 호환성 오류
3. normalized registry digest 재입력 오류
4. Mission resume registry drift 가능성
5. retrieval score를 memory 원본 변조로 오판
6. informational impact를 필수 후속 작업으로 오판
7. daemon shutdown 테스트 정리 경쟁
8. source freshness 미표시와 stale source fail-closed 부재
9. 실행 관측과 routing policy 경계 부재

## 9. 잔여 게이트

- Hermes가 확정한 공개 v1.1.0 exact tree에 패키지 통합
- 실제 OpenCode·Pi·Claude·Orca host에서 exact model ID·tool·permission·disconnect/reconnect canary
- 실제 모델 품질·비용·latency 측정과 Registry calibration
- 팀 RBAC·mTLS·분산 저장은 별도 후속 범위

## 10. 결론

여섯 Runtime과 외부 운영 표면의 오프라인 구현 및 독립 검증은 완료됐다. live/integration gate를 통과하기 전에는 production-wide 승인이나 실제 모델 우수성 주장을 하지 않는다.
