# Model Routing Runtime

## 목표

WorkItem의 capability, 위험도, 데이터 등급, context 크기, 비용, latency, health를 기준으로 exact model ID를 선택하고, 선택과 실행 결과를 분리된 증거로 보존한다.

## ModelRegistry

예제: `examples/model-registry.example.json`

예제 항목은 안전을 위해 모두 `enabled: false`다. 운영자는 실제 Host의 exact model ID와 검증된 capability·비용·context limit을 입력한 뒤 필요한 항목만 활성화한다.

```bash
proofgraph start --model-registry ./model-registry.json
# 또는
export PROOFGRAPH_MODEL_REGISTRY=/absolute/path/model-registry.json
```

Registry loader는 파일 크기, JSON schema, symlink, unknown field, digest를 검사한다.

## 선택 절차

```text
필수 capability 계산
→ enabled/health 확인
→ data classification 확인
→ risk ceiling 확인
→ context limit 확인
→ cost/host/model allowlist 확인
→ deterministic score
→ exact selected model + fallback chain 기록
```

`RouteDecision`에는 registry version/digest, 선택 사유, 거절 모델과 이유, 예상 비용이 남는다. Mission 재개 시 registry digest가 달라지면 fail-closed한다.

## ModelObservation

실행 후 다음을 append-only 관측 증거로 기록한다.

```text
observation_id
route_id / work_item_id / exact model_id
provider / host / attempt
success / status / failure_type
calls / tokens / cost_micros / latency_ms
observed_at / digest
```

TUI와 CLI는 model별 성공률, 실패 수, 평균 latency, tokens, cost를 집계해 보여준다.

### 중요한 정책

`ModelObservation`은 라우팅 정책을 **자동 변경하지 않는다**. 관측 데이터가 공격·일시 장애·표본 편향에 의해 오염될 수 있기 때문이다. Registry 변경은 별도 평가, canary, 승인, 버전 갱신을 거쳐 명시적으로 적용한다.

## 현재 제한

실제 모델 품질·비용·latency 값은 실환경 canary로 교정해야 한다. 예제 값을 공급자 성능 주장으로 사용하면 안 된다.
