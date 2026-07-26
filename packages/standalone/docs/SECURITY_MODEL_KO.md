# ProofGraph Operator v3.0.0 보안 모델

## 신뢰 경계

```text
External Human Operator        trusted for explicit decisions
Operator TUI/CLI               trusted client, not state authority
proofgraphd                    command and projection authority
Runtime/HashChainStore         execution state authority
OpenCode/Model/Plugin          untrusted for operator decisions
Host event payload             untrusted observability input
```

## Token 분리

- `.operator-api-token`: Run 생성·Pause·Retry·승인·거절·Abort·Shutdown
- `.host-ingest-token`: OpenCode event ingest만 가능

두 Token은 서로 다른 CSPRNG 값이며 endpoint에서 상호 대체할 수 없다. POSIX에서는 0600을 요구하고 symlink를 거부한다.

## Approval

- challenge는 persisted Runtime state와 secret에 결합
- Control Plane이 서버 내부에서 조회
- REST·SSE·projection·TUI·OpenCode에 challenge 미노출
- 모델은 승인·거절 명령에 접근 불가
- TUI는 사용자에게 `YES`/`ABORT` 재확인 요구

이 구조는 상태 연속성과 UI 우회를 방어하지만 운영자의 법적 신원을 암호학적으로 인증하지는 않는다.

## Network

- 기본 bind는 loopback
- remote bind는 명시적 flag 필요
- 내장 TLS·RBAC 없음
- Host Bridge remote 연결은 기존 v1.1 정책에 따라 HTTPS 필요
- HTTP body·Host event·SSE client 상한 적용

## Data integrity

- state digest
- event hash chain
- stale revision conflict
- symlink replacement 거부
- command ledger hash chain
- projection digest

변조는 fail-closed이며 TUI가 임의로 복구하지 않는다.

## UI security

- ANSI escape 제거
- C0 control 문자 제거
- 문자열·graph node 표시 상한
- Approval challenge 마스킹
- Token은 화면에 표시하지 않음

## OpenCode Plugin

Plugin은 Host Ingest Token만 사용한다. 이벤트는 depth·length·item 상한과 민감 key 마스킹을 적용한다. 전송 오류는 OpenCode 작업을 막지 않는다. 이벤트 조작은 화면 관측을 오염시킬 수 있으나 Run 명령·승인 권한을 부여하지 않는다.

## 잔여 위험

- 로컬 사용자 계정이 데이터 디렉터리를 완전히 탈취하면 Token도 탈취 가능
- 단일 사용자 파일 저장소이며 팀 RBAC가 없음
- remote mode에 TLS가 내장되지 않음
- Host 이벤트의 의미적 진실성은 cryptographic attestation이 아님
- 실제 OpenCode extension/API 버전 호환성은 live canary 필요
