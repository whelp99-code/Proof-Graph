# Hermes용 ProofGraph v1.1.0 → Operator v3.0.0 통합 지시서

## 목표

Hermes가 확정한 ProofGraph v1.1.0 Host Runtime을 `@proofgraph/operator` v3.0.0의 실행 하위 계층으로 연결한다. v1.1.0의 OpenCode·Pi·Orca 실행 계약을 유지하고, v3.0.0의 Control Plane과 Operator TUI가 Run·Node·Edge·Loop·Failure·Approval·Artifact·Host 상태를 실시간으로 표시하도록 한다.

## 통합 원칙

1. v1.1.0의 Host Adapter를 삭제하거나 v3 Reference Kernel로 대체하지 않는다.
2. v3.0.0은 Control Plane·Projection·Operator UI를 담당하고, 실제 Host 실행은 `proofgraph.host.v1` Bridge 계약으로 위임한다.
3. OpenCode 작업 완료와 ProofGraph 검증 완료를 동일한 상태로 처리하지 않는다.
4. 모든 실패·역라우팅·승인·거절·재시도는 Event Envelope v2로 기록한다.
5. Operator 명령은 모델용 Host/MCP 토큰과 분리된 Operator API 토큰만 사용한다.
6. v1.1.0과 v3.0.0의 기존 테스트를 모두 유지하고 교차 계층 적대적 검증을 추가한다.

## 권장 저장소 배치

```text
Proof-Graph/
├─ 기존 v1.1.0 runtime 및 host adapters
└─ packages/
   └─ operator/
      ├─ runtime/control-plane/
      ├─ runtime/operator/
      ├─ runtime/observability/
      ├─ runtime/hosts/
      ├─ bin/
      └─ tests/
```

## 필수 연결 계약

```text
v3 WorkItem
  → HostBridgeGraphPort.start/resume
  → proofgraph.host.v1 request
  → v1.1 OpenCode/Pi/Orca Host Adapter
  → normalized host events
  → v3 Host Registry + Event Projection
  → verifier result
  → completed_clean / completed_with_recovery / failed
```

Host event 최소 필드:

```json
{
  "schema_version": 2,
  "run_id": "...",
  "node_id": "...",
  "host": "opencode",
  "session_id": "...",
  "event_type": "host.tool.completed",
  "sequence": 1,
  "at": "ISO-8601",
  "data": {}
}
```

## 통합 순서

1. Hermes v1.1.0 최종 태그와 commit SHA를 기록한다.
2. v3.0.0을 `packages/operator`에 추가한다.
3. v1.1 Host Bridge URL·토큰·Host 이름을 v3 Run 생성 옵션에 연결한다.
4. OpenCode 세션 상태와 도구 이벤트를 v3 Host Registry에 전달한다.
5. `route.changed`, `loop.*`, `approval.*`, `host.*` 이벤트를 교차 계층에서 보존한다.
6. `proofgraph start`로 Control Plane과 TUI를 시작하고 v1.1 Host를 연결한다.
7. direct, research, develop→verify, recovery loop, approval의 5개 canary 유형을 각 4건 실행한다.
8. 모든 검증이 통과한 뒤 통합 PR과 릴리스를 만든다.

## 병합 게이트

```text
v1.1 전체 회귀                       PASS
v3.0.0 자동 시험                     PASS
v3 독립 Control Plane/TUI 검증        PASS
OpenCode live canary 20건             PASS
Pi live canary                        PASS 또는 Experimental 명시
Orca compatibility canary             PASS 또는 Experimental 명시
Verifier bypass                       0
Approval bypass                       0
Silent failure                        0
SSE sequence gap                      0 또는 snapshot recovery 100%
모든 Run finalize/abort               100%
```

## 최종 보고

- v1.1.0 기준 SHA와 v3.0.0 통합 SHA
- Host별 canary 결과
- Control Plane/TUI 스크린샷 또는 asciicast
- 회복 루프와 승인·거절 재현 로그
- 실패·제한 사항
- 최종 판정: `RELEASED`, `RELEASED_WITH_DOCUMENTED_LIMITATIONS`, `BLOCKED`
