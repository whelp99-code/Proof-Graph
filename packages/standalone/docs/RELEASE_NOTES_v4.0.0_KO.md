# ProofGraph Intelligence v4.0.0 릴리스 노트

## 추가

- 역할 최소화 Context Delivery Runtime
- source freshness·staleness 정책과 fail-closed 옵션
- exact Model Registry와 deterministic Router
- immutable ModelObservation ledger와 model별 집계
- versioned WorkContract/Handoff Runtime
- bounded Knowledge & Impact Graph
- append-only Organization Memory
- Intelligence Verification Gate
- `pg4_*` 읽기 전용 MCP 도구 8개
- 인증 REST Intelligence API와 model-observations endpoint
- TUI Context·Models·Collaboration·Knowledge·Memory·Verification View
- `--model-registry`와 `PROOFGRAPH_MODEL_REGISTRY`

## 보안

- 중첩 secret leaf-key redaction
- stale source policy consistency 검증
- model registry symlink·size·schema·digest 검사
- registry drift fail-closed
- ModelObservation digest 검증과 policy 자동변경 금지
- self-only contract와 memory self-verification 차단
- impact/memory/context/route/observation digest 검증
- Operator 권한은 MCP 모델 표면에 노출하지 않음

## 검증

```text
자동 시험                         174/174 PASS
Coverage                           97.02 / 76.96 / 93.00
기존 CLI/MCP 독립 검증             18/18 PASS
Operator 독립 검증                 15/15 PASS
Intelligence 독립 검증             11/11 PASS
Preflight                          13 PASS / 0 FAIL / 2 SKIP
```

## 릴리스 경계

오프라인 코드와 계약은 검증됐지만 공개 v1.1 exact tree 통합, 인증된 다중 Host/모델 canary, 실제 품질·비용·latency calibration이 남아 있다.
