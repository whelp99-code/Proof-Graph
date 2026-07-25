# ProofGraph v1.0.2 출시 판정

## 판정

```text
PASS_OFFLINE_ORCA_LIVE_CANARY_REQUIRED
```

v1.0.2는 ProofGraph Graph Runtime을 Orca의 Task·worktree·terminal·Dispatch와 연결하는 compatibility bridge의 코드·계약·적대적·독립 CLI 검증을 완료했다. 실제 Orca Desktop 및 실제 Claude/Codex/OpenCode Agent는 이 빌드 환경에서 실행하지 않았으므로 live canary 전 mutation과 무인 운영은 승인하지 않는다.

## 허용

- Orca CLI와 Orchestration의 읽기 전용 live preflight
- 최대 3-worker, read-only, clean repository canary
- 명시적 `repo_selector`로 고정된 로컬 저장소에서의 compatibility bridge
- matching `taskId + dispatchId` 기반 완료 판정
- Orca worktree 내부 exact JSON report 수집
- 실패·escalation·decision gate의 명시적 보존

## 필수 조건

- Settings → Agents → Agent Permissions를 Manual로 설정
- `orca repo list --json`에서 대상 ID 확인
- `adapters.orca.repo_selector="id:<repoId>"`
- `workspace.enabled=false`
- `allow_workspace_mutation=false`
- 설치 Orca 버전 고정 및 기록

## 금지

- Manual UI 확인 없이 `manual_permissions_confirmed=true` 설정
- 활성 UI 저장소 추론에 의존하거나 `repo_selector`를 생략
- Orca Yolo/bypass permission과 ProofGraph approval policy 동시 사용
- ProofGraph Workspace Engine과 Orca worktree 동시 활성화
- live canary 전 mutation, push, merge, PR, deploy, DB·secret·권한 변경
- Remote Orca Server 또는 SSH worktree에서 local report path 신뢰
- 현재 bridge를 strict Orca-native state backend라고 표시
- terminal idle 또는 heartbeat를 완료로 간주

## 다음 출시 게이트

1. 사용자 Mac에서 read-only preflight
2. Orca 버전 및 CLI JSON shape 보존
3. 최대 3-worker read-only fan-out
4. stale dispatch·decision gate·Orca restart 시나리오
5. 실행 전후 원본 저장소 `git status` 무변경
6. 모든 Task/Dispatch/report metadata와 Graph integrity PASS
7. 총 20건 live canary 후 mutation 정책 재검토
