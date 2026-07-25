# ProofGraph v1.1.0 운영 가이드

## 1. 권장 도입 단계

```text
Mock 로컬 검증
→ OpenCode·Pi Host Bridge 오프라인 계약 시험
→ 읽기 전용 실제 Host/Worker canary
→ 승인형 disposable worktree
→ 제한된 팀 pilot
→ Container/VM sandbox를 붙인 자동 실행
```

OpenCode와 Pi는 사용자 인터페이스와 세션을 제공하는 Host입니다. GraphSpec·ready node·검증·실패 역라우팅·승인·Workspace·terminal 상태의 최종 권위자는 ProofGraph입니다.

## 2. 매일 운영

1. `proofgraph doctor`로 config·Adapter·Workspace·Debugger 상태 확인
2. `proofgraph hosts`와 `proofgraph host paths`로 설치 상태 확인
3. Host Bridge를 프로젝트별 token·port로 시작
4. `proofgraph start` 또는 Host의 `/pg`로 Graph를 생성하고 위험도·경로 확인
5. 필요한 breakpoint 설정 후 `resume`
6. approval 대기 시 위험·부작용·rollback을 검토
7. workspace action은 proposal digest 확인 후 승인
8. `integrity`, `inspect`, `report`를 확인한 뒤 결과 채택
9. 실패 Run은 삭제하지 말고 `abort` 또는 terminal 상태로 보존

## 3. OpenCode 운영

### 설치

```bash
cd /개발/저장소
proofgraph host install opencode --scope project
```

설치기는 `.opencode/package.json`을 보존형으로 병합하고 `@opencode-ai/plugin@1.18.4`를 고정한다. 기존 버전이 다르면 `--force` 없이는 중단한다. OpenCode를 한 번 시작하면 공식 로더가 config-root 의존성을 설치한다.

### Host Bridge

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8743"
proofgraph host serve opencode --port 8743 --token "$PROOFGRAPH_HOST_TOKEN"
```

Bridge는 foreground 프로세스입니다. 다른 터미널에서 같은 환경 변수를 전달한 뒤 OpenCode를 시작합니다.

### OpenCode 자체 권한

OpenCode의 `permission`도 별도로 제한합니다. 최소 권장 경계는 다음과 같습니다.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "ask",
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "edit": "deny",
    "bash": "deny",
    "external_directory": "deny"
  }
}
```

ProofGraph Plugin의 `tool.execute.before`는 추가 방어선입니다. OpenCode 자체 권한을 모두 허용하거나 `--auto`를 켠 상태를 production canary로 인정하지 않습니다.

### Server Worker

```bash
export OPENCODE_SERVER_PASSWORD="..."
cp examples/opencode-host.config.json proofgraph.config.json
proofgraph adapters
proofgraph doctor
npm run hosts:preflight
```

서버는 기본적으로 loopback만 허용합니다. 원격 서버를 쓸 경우 명시적 설정, HTTPS, Basic Auth, 네트워크 경계가 모두 필요합니다.

### 확인 사항

```text
/global/health 성공
/global/event SSE 연결
JSON Schema structured_output 수신
StructuredOutputError가 silent success로 승격되지 않음
session.diff가 Artifact로 기록됨
abort·timeout 후 Node failure 보존
```

## 4. Pi 운영

### 설치

```bash
cd /개발/저장소
proofgraph host install pi --scope project
```

Pi 0.82.0 계약은 Node.js 22.19.0 이상이 필요하다. Pi core extension import와 `typebox`는 Pi가 제공하므로 별도 복사하지 않는다.

### Host Bridge

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8744"
proofgraph host serve pi --port 8744 --token "$PROOFGRAPH_HOST_TOKEN"
```

같은 환경 변수를 전달한 터미널에서 Pi를 시작합니다. Extension은 `/pg`, `/pg-status`, `/pg-resume`, `/pg-report`, `/pg-integrity`, 승인·거부·중단 명령을 제공합니다.

### RPC Worker

```bash
cp examples/pi-host.config.json proofgraph.config.json
proofgraph adapters
proofgraph doctor
npm run hosts:preflight
```

기본 Worker는 discovery와 session을 끄고 read-only 도구만 제공합니다. `extension_ui_request`가 필요한 작업은 기본적으로 실패시키며, 자동 승인하지 않습니다.

### 확인 사항

```text
LF JSONL framing 유지
Unicode line separator 오분할 없음
agent_settled 전용 종료 감지 (`agent_end`는 중간 이벤트로만 기록)
blocking UI 요청 fail-closed 또는 명시적 cancel
malformed JSON·timeout·output cap 실패 보존
Pi session entry에서 active Run 복구
```

Pi Extension은 운영체제 Sandbox가 아닙니다. mutation 또는 shell을 활성화하려면 ProofGraph 격리 Workspace와 별도 Container/VM 경계가 필요합니다.

## 5. 실제 Adapter 승격 조건

```text
설치 버전 기록
인증 성공
Host/Worker별 대표 canary 20건
구조화 출력 성공률 ≥ 99%
금지 도구 실행 0건
승인 우회 0건
timeout·abort·resume 확인
오류가 Failure Packet으로 보존
비용과 p50/p95 지연 측정
```

OpenCode Host, OpenCode Worker, Pi Host, Pi Worker는 각각 별도 canary 결과를 가져야 합니다. 한쪽의 성공으로 다른 실행면을 인증하지 않습니다.

## 6. 장애 대응

- Host Bridge disconnect: active Run에서는 도구 정책을 fail-closed로 처리; Bridge 복구 후 상태 재조회
- Adapter crash: Failure Packet 확인 후 graph-defined retry 또는 다른 Adapter로 재실행
- OpenCode SSE disconnect: Session 상태·message·diff를 재조회하고 중복 completion을 거부
- Pi JSONL 파서 오류: Run을 성공으로 승격하지 않고 Worker stderr·raw envelope을 보존
- MCP disconnect: 같은 project/data directory에서 재시작 후 `status`
- debug state 오류: 직접 수정하지 말고 백업 후 새 Run; digest 오류는 우회하지 않음
- workspace action 실패: 자동 rollback receipt 확인
- event/state tamper: Run을 신뢰하지 않고 보존 후 새 Run 시작
- active Run deadlock: `proofgraph abort <run_id> "reason"`으로 명시 종료

## 7. 승인 운영 한계

Host Bridge의 일반 도구 정책은 `allow`, `deny`, `require_approval`을 반환합니다. 현재 OpenCode·Pi Host Plugin은 `require_approval`을 자동 실행하지 않고 **차단**합니다. 사용자는 ProofGraph가 이미 생성한 명시적 Approval Node를 Host 명령으로 승인한 뒤 Run을 재개해야 합니다.

즉, 임의 Host tool 요청을 자동으로 새로운 Graph Approval Node로 변환하는 기능은 v1.1.0 범위가 아닙니다. 이 경계는 silent auto-approval보다 안전한 fail-closed 동작입니다.

## 8. 백업

`.proofgraph/runs/<run_id>` 전체를 보관합니다. `state.json`만 따로 복사하면 event chain·report·debugger·workspace receipt를 잃습니다.

Host 이벤트는 프로젝트 데이터 디렉터리의 `host-events/<host>.jsonl`에도 append-only로 기록됩니다. 인증 token은 백업에 포함하지 않습니다.

## 9. 검증 증거

```bash
npm test
npm run test:hosts
npm run preflight
npm run verify:hosts
npm run hosts:preflight
npm run release:verify
```

`verification/*.json`은 릴리스 증거이며 `BUILD_MANIFEST.json`에 해시가 고정됩니다. 재실행 결과는 `verification/tmp/`에 기록되고 패키지 inventory에서는 제외됩니다.

## 10. Orca 운영

Orca는 3순위 호환 Execution Host로 유지합니다.

1. Orca Agent Permissions를 Manual로 설정
2. `examples/orca-bridge.config.json`을 복사하고 실제 agent map 설정
3. `workspace.enabled=false` 유지
4. `orca status --json`, `proofgraph adapters`, `proofgraph doctor` 확인
5. 읽기 전용 direct canary부터 실행
6. `worker_done` task/dispatch/report 계약과 `integrity` 확인
7. 20건 canary 전 `allow_workspace_mutation` 금지
8. Orca 업그레이드 후 `npm run test:orca`와 실제 contract canary 재실행

동일 Dispatch의 자동 durable resume은 v1.1.0 범위가 아닙니다.

## 11. 현재 출시 게이트

```text
PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED
```

오프라인 계약·적대적·블랙박스 검증은 완료됐지만, 이 빌드 환경에는 실제 OpenCode·Pi 바이너리와 인증 세션이 없어 live canary를 실행하지 않았습니다.
