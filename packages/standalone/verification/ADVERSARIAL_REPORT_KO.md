# ProofGraph Intelligence v4.0.0 적대적 검증 보고서

## 결과

```text
전체 자동 시험 포함 적대적·경계 검증: PASS
전체 시험: 174/174
독립 블랙박스: 44/44
Verifier bypass: 0
Operator authority bypass: 0
Registry drift bypass: 0
Silent failure promotion: 0
```

## Intelligence 공격 범위

### Context Delivery

- nested secret leaf-key 우회
- API key·Bearer·private key 패턴 노출
- 절대 사용자 홈 경로 노출
- source digest 변조
- packet section 변조
- stale source를 fresh로 위장
- stale source reject 정책 우회
- oversized/circular/non-finite Context

### Model Routing

- capability 부족 모델 선택
- risk ceiling 초과
- restricted data 미허용 모델
- host/model allowlist 우회
- context limit 초과
- disabled/unhealthy model 선택
- registry symlink
- registry digest drift
- RouteDecision exact model ID 변조
- ModelObservation token/cost/latency 변조
- 관측으로 Registry 자동 변경 시도

### Collaboration

- producer-only self contract
- consumer 없는 계약
- acknowledgement 위조
- evidence/output 없는 완료
- 다른 역할의 계약 completion
- reject/block/cancel 상태 무시
- 열린 계약 상태에서 terminal 승격

### Knowledge / Memory

- duplicate node/edge
- missing node edge
- N-hop bound 초과
- impact digest 변조
- informational impact의 action 강제
- producer의 memory self-verification
- unverified/rejected/expired memory recall
- sensitivity ceiling 우회
- memory state/event tampering

### Verification / Operator

- Context·Route·Contract·Handoff·Impact·Memory verifier 우회
- failed execution bundle을 terminal success로 승격
- 모델/MCP의 approve·deny·abort 호출
- Host token의 Operator API 접근
- Approval challenge projection 노출
- state/event chain 변조

## 판정

공격은 `PolicyError`, `IntegrityError`, `ValidationError`, `401`, `403`, `409`, `BLOCKED`, `DENIED`, `FAILED_SAFE` 또는 bounded output으로 종료됐다.

## 범위 제한

실제 공급자 계정 탈취, 악성 Host 바이너리의 OS 권한 탈취, remote TLS/RBAC, 의미적으로 잘못된 Registry calibration은 오프라인 범위 밖이다.
