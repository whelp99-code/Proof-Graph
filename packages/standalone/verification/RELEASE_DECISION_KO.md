# ProofGraph Intelligence v4.0.0 출시 판정

## 판정

```text
PASS_OFFLINE_V1_1_INTEGRATION_AND_MULTI_MODEL_CANARY_REQUIRED
```

## 완료된 근거

```text
자동 시험                         174/174 PASS
Coverage                          97.02 / 76.96 / 93.00
기존 CLI/MCP 독립 검증             18/18 PASS
Operator 독립 검증                 15/15 PASS
Intelligence 독립 검증             11/11 PASS
독립 검증 합계                     44/44 PASS
Preflight                          13 PASS / 0 FAIL / 2 SKIP
Operator benchmark P95             0.415 / 0.559 / 7.543 ms
```

## 의미

Context Delivery, exact Model Routing, ModelObservation, Collaboration Contract, Knowledge/Impact, Organization Memory, Intelligence Verification, CLI·MCP·REST·TUI 연결은 오프라인 기준으로 완료됐다.

## production 승격 조건

1. 공개 v1.1.0 exact tree에 통합하고 v1.1+v4 전체 회귀 PASS
2. 인증된 OpenCode·Pi·Claude·Orca 중 실제 지원 대상으로 정한 Host canary
3. exact model ID와 실행 모델 일치 확인
4. cost·latency·quality 관측에 따른 Registry calibration
5. cross-layer Verifier·Approval·Context·Registry 우회 0
6. 운영자 명시적 승인

그 전에는 조직 전체 무인 운영, 고위험 production mutation, 특정 모델의 객관적 우수성을 주장하지 않는다.
