# ProofGraph Operator v3.0.0 운영 가이드

## 1. 설치 전 검증

```bash
npm ci --ignore-scripts
npm run release:verify
```

개별 실행:

```bash
npm test
npm run coverage
npm run preflight
npm run verify:independent
npm run verify:operator
npm run build:manifest
npm run verify:package
```

## 2. 시작

```bash
npm link
proofgraph start
```

새 Mission을 동시에 시작:

```bash
proofgraph start --new \
  "인증 API를 구현하고 보안 및 회귀 테스트로 독립 검증하라"
```

기본 데이터 경로:

```text
./.proofgraph-org
```

별도 경로:

```bash
proofgraph start --data-dir /absolute/path/proofgraph-data
```

## 3. 분리 실행

```bash
# Control Plane
proofgraphd --data-dir .proofgraph-org --port 8742

# Operator TUI
proofgraph tui --data-dir .proofgraph-org --url http://127.0.0.1:8742
```

## 4. Headless 조회

```bash
proofgraph status
proofgraph status <run_id>
proofgraph snapshot --run <run_id> --view graph
proofgraph snapshot --run <run_id> --view org
proofgraph snapshot --run <run_id> --view cycles
proofgraph snapshot --run <run_id> --view timeline
proofgraph snapshot --run <run_id> --view failures
proofgraph approvals
proofgraph hosts
```

## 5. 완료 판정

| 표시 | 운영 해석 |
|---|---|
| `COMPLETED CLEAN` | 실패 없는 검증 완료 |
| `COMPLETED WITH RECOVERY` | 과거 실패가 있었으나 해결 후 검증 완료 |
| `WAITING APPROVAL` | 운영자 결정 필요 |
| `PARTIAL` | 일부 결과 또는 한도 도달 |
| `FAILED` | 미해결 실패 |
| `DENIED` | 사람 거절로 종료 |
| `ABORTED` | 운영자 중단 |

최종 성공 판정:

```text
status ∈ {completed_clean, completed_with_recovery}
AND quality_gate_passed == true
AND unresolved failure == 0
AND pending approval == 0
AND integrity == ok
```

## 6. 장애 대응

### TUI만 종료

`Q`를 누른다. `proofgraphd`는 유지된다.

### TUI 재접속

```bash
proofgraph tui --data-dir .proofgraph-org
```

### Control Plane 상태 확인

```bash
proofgraph doctor --data-dir .proofgraph-org
```

### Control Plane 종료

```bash
proofgraph stop --data-dir .proofgraph-org
```

### Active Mission 명시적 중단

TUI에서 `X`, 또는 API/CLI 운영 경로를 사용한다. 상태 파일을 직접 삭제하지 않는다.

### Integrity 오류

1. TUI에서 추가 명령을 중단한다.
2. 데이터 디렉터리 전체를 복사한다.
3. `state.json`과 `events.jsonl`을 수동 수정하지 않는다.
4. 원본 Run을 보존하고 새 Run을 생성한다.
5. 변조 원인을 별도 조사한다.

## 7. OpenCode

```bash
proofgraph install-opencode --project /absolute/project
```

실행 관측 환경:

```bash
export PROOFGRAPH_CONTROL_URL=http://127.0.0.1:8742
export PROOFGRAPH_HOST_TOKEN="$(cat .proofgraph-org/.host-ingest-token)"
```

실행 Bridge를 연결할 때:

```bash
proofgraphd \
  --bridge-url http://127.0.0.1:8743 \
  --bridge-token "$PROOFGRAPH_HOST_BRIDGE_TOKEN" \
  --runtime-host opencode
```

## 8. 백업

Runtime이 정지된 상태에서 데이터 디렉터리 전체를 백업한다.

```bash
proofgraph stop
cp -R .proofgraph-org .proofgraph-org.backup-$(date +%Y%m%d%H%M%S)
```

다음 파일을 개별로 떼어 백업하지 않는다.

```text
state.json only
events.jsonl only
token files only
```

## 9. 업데이트

```text
모든 중요 Run 상태 확인
→ pending approval 처리
→ Control Plane 종료
→ 데이터 디렉터리 백업
→ 새 패키지 release:verify
→ 설치 교체
→ proofgraph doctor
→ canary Mission
```

## 10. Live Canary 권장 세트

| 유형 | 건수 |
|---|---:|
| Clean direct/plan/develop/verify | 4 |
| Research fan-out | 4 |
| Verify failure recovery loop | 4 |
| Human approval approve/deny | 4 |
| OpenCode disconnect/reconnect | 4 |
| 합계 | 20 |

통과 조건:

```text
금지 Operator 명령 우회 0
Verifier 우회 0
Approval challenge 노출 0
Silent failure 0
SSE 복구 실패 0
모든 Run 명시적 terminal 100%
```
