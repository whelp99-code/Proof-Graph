# ProofGraph × Orca 통합 설계 및 운영 가이드

## 1. 결론

Orca는 ProofGraph의 별도 TUI를 대체하는 **운영 화면·Agent 프로세스·Git worktree Host**로 적합하다. ProofGraph는 자연어 목표를 GraphSpec으로 컴파일하고 검증·실패 역라우팅·예산·승인 정책을 계산하며, Orca는 각 실행 노드에 필요한 실제 worktree와 agent terminal을 제공한다.

v1.0.2에 구현된 것은 **Orca Compatibility Bridge**다.

```text
ProofGraph Kernel                     Orca Runtime
────────────────                     ────────────
GraphSpec과 Graph 상태의 권위자       Worktree·Terminal·Agent의 권위자
Ready Node 계산                       Task 기록
검증·실패 라우팅                     Dispatch와 worker_done 전달
최종 Quality Gate                    Diff·Terminal·Worktree 운영 화면
```

현재 모드는 strict Orca-native가 아니다. `.proofgraph`의 Graph RunState와 Event Log는 여전히 ProofGraph가 보유한다. 향후 strict native backend에서는 Orca Task/Dispatch/Gate/Inbox가 실행 상태의 유일한 권위자가 되고 ProofGraph는 stateless compiler와 policy reconciler로 축소할 수 있다.

## 2. 왜 Orca와 잘 맞는가

Orca는 여러 CLI Agent를 실제 Git worktree와 terminal에서 실행하고, 작업·dispatch·worker 완료·decision gate를 추적하는 구조화된 Orchestration 계층을 제공한다. ProofGraph의 실행 모델과 다음처럼 대응한다.

| ProofGraph | Orca |
|---|---|
| Graph Node | Task |
| Node Attempt | Dispatch |
| Agent Adapter 선택 | Orca Agent 선택 |
| 격리 실행 공간 | Orca worktree |
| Agent process | Orca terminal |
| AgentResult | worktree 안의 JSON report |
| Node 완료 신호 | matching `worker_done` |
| Failure Packet | `escalation` 또는 failed AgentResult |
| Human gate | `decision_gate` projection |
| Graph event | Task/Dispatch/Message 메타데이터 |

## 3. 실행 흐름

한 ProofGraph 노드는 다음 순서로 실행된다.

```text
1. ProofGraph가 Ready Node를 선택
2. `orca orchestration task-create`
3. 명시적 `--repo id:<repoId>`를 포함해 `orca worktree create --agent <agent>`
4. 새 worktree의 terminal handle 조회
5. terminal이 idle이 될 때까지 제한 시간 대기
6. `orca orchestration dispatch --inject`
7. `orca orchestration check --all --wait`
8. 정확히 일치하는 taskId + dispatchId만 수락
9. worker_done의 report-path가 계약 경로와 같은지 확인
10. worktree 내부 JSON report를 읽어 AgentResult 검증
11. ProofGraph Verifier·Router가 다음 Edge를 선택
```

`terminal idle`, OSC 상태, heartbeat는 완료로 취급하지 않는다. 활성 Dispatch의 `taskId`와 `dispatchId`가 모두 일치하는 `worker_done`만 완료 권한을 가진다. 오래된 retry의 완료 메시지, 다른 task의 메시지, dispatch ID가 없는 메시지는 무시한다.

## 4. 이중 오케스트레이션 방지

ProofGraph bridge에서는 다음 명령을 사용하지 않는다.

```text
orca orchestration run
orca orchestration reset
orca terminal send
orca exec
orca computer
```

`orca orchestration run`은 Orca가 자체 coordinator loop를 소유할 때 적합하다. ProofGraph가 Graph routing을 소유하는 compatibility bridge에서 함께 사용하면 두 coordinator가 다음 실행 경로를 동시에 결정하게 된다. 따라서 bridge는 `task-create → worktree → dispatch → check`의 수동 추적 흐름만 사용한다.

## 5. 병렬 실행과 메시지 소비

ProofGraph는 여러 Ready Node를 병렬 실행할 수 있다. Orca의 기본 `orchestration check --unread`는 일치 메시지를 읽음 처리하므로, 독립 waiter 여러 개가 서로의 `worker_done`을 소비할 위험이 있다.

Bridge는 다음을 사용한다.

```text
orca orchestration check \
  --all \
  --wait \
  --types worker_done,escalation,decision_gate
```

`--all`로 메시지를 읽음 처리하지 않고, 각 waiter가 `taskId + dispatchId`로 자기 메시지만 필터링한다. 이 조합은 모의 Orca 병렬 fan-out 검증을 통과했지만, 설치된 Orca 버전에서의 live contract는 첫 canary에서 반드시 확인한다.

## 6. 권한과 안전 경계

Orca의 기본 Agent launch는 지원 CLI의 autonomy/bypass 인자를 채울 수 있다. ProofGraph와 함께 사용할 때는 반드시 Orca에서 다음을 설정한다.

```text
Settings → Agents → Agent Permissions → Manual
```

그 다음 `proofgraph.config.json`에서 운영자가 직접 확인값을 바꾼다.

```json
{
  "adapters": {
    "orca": {
      "enabled": true,
      "manual_permissions_confirmed": true
    }
  }
}
```

이 값은 Orca UI 상태를 암호학적으로 증명하지 않는 운영자 self-attestation이다. 실제 UI 설정을 확인하지 않고 `true`로 바꾸면 안전 경계가 무효화된다.

기본 bridge는 다음을 강제한다.

- `manual_permissions_confirmed=false`이면 dispatch 전에 fail-closed
- `repo_selector`가 없으면 dispatch 전에 fail-closed
- ProofGraph Workspace Engine과 Orca worktree의 동시 활성화 거부
- `allow_workspace_mutation=false` 기본값
- Node별 agent override 비활성
- 활성 UI 선택에 의존하지 않는 명시적 repo selector
- Agent allowlist 적용
- Task spec 크기 제한
- Result report 크기 제한
- 절대 경로·`..`·경로 탈출·symlink report 거부
- exact report path 불일치 거부
- 중복 `worker_done` 거부
- 오래된 dispatch 완료 무시
- 보안·자격증명 escalation을 non-retryable `security_risk`로 변환

## 7. 설치 전 Orca 설정

1. Orca Desktop을 설치하고 실행한다.
2. Settings → Experimental에서 CLI를 등록한다.
3. Settings → Experimental에서 Orchestration을 활성화한다.
4. Settings → Agents → Agent Permissions를 Manual로 변경한다.
5. 사용할 Claude Code, Codex, OpenCode 등의 CLI를 설치하고 각 CLI에 로그인한다.
6. 작업 저장소를 Orca에 등록한다.
7. `orca repo list --json`에서 대상 저장소 ID를 확인하고 ProofGraph 설정에 `id:<repoId>`로 고정한다.
8. base ref와 clean 상태를 확인한다.

터미널에서 최소 확인:

```bash
command -v orca
orca status --json
orca repo list --json
# 사용할 저장소의 ID를 id:<repoId> 형태로 기록
orca worktree ps --json
orca orchestration task-list --json
```

## 8. 읽기 전용 Live Preflight

ProofGraph 패키지 루트에서 실행한다.

```bash
npm run orca:preflight -- \
  --manual-confirmed \
  --output verification/orca-live-preflight.json
```

Preflight가 실행하는 명령은 조회 전용이다.

```text
status
repo list
worktree ps
terminal list
orchestration task-list
orchestration gate-list --status pending
orchestration inbox --limit 20
automations list
skills get orchestration --full
```

Task·worktree·terminal·dispatch를 만들거나 메시지를 보내지 않는다.

## 9. 안전한 설정 예시

`examples/orca-bridge.config.json`을 프로젝트의 `proofgraph.config.json`으로 복사한 뒤 repo selector와 agent 이름을 환경에 맞게 조정한다.

```json
{
  "default_adapter": "orca",
  "workspace": { "enabled": false },
  "adapters": {
    "orca": {
      "enabled": true,
      "command": "orca",
      "repo_selector": "id:<repoId>",
      "require_explicit_repo_selector": true,
      "manual_permissions_confirmed": true,
      "allow_workspace_mutation": false,
      "allow_inline_result": false,
      "agent_map": {
        "direct": "claude",
        "researcher": "claude",
        "planner": "claude",
        "developer": "codex",
        "verifier": "claude",
        "synthesizer": "claude"
      },
      "allowed_agents": ["claude", "codex"]
    }
  }
}
```

## 10. 첫 Live Canary

첫 canary는 다음 조건으로 제한한다.

```text
최대 worker: 3
작업 유형: 읽기 전용 분석·요약·검증
Workspace mutation: false
Shell mutation: false
외부 게시·push·merge: 금지
실행 전 git status: clean 확인
실행 후 git status: 변경 없음 확인
```

예:

```bash
proofgraph run \
  "이 저장소의 세 핵심 모듈을 독립적으로 분석하고, 읽기 전용으로 구조를 검증하라" \
  --template research \
  --adapter orca
```

Canary 합격 조건:

- 각 ProofGraph Node에 Orca Task와 Dispatch ID가 기록됨
- 각 시도에 독립 Orca worktree가 만들어짐
- 최대 병렬 worker가 3을 넘지 않음
- matching `taskId + dispatchId`만 완료로 수락됨
- stale completion이 현재 Node를 완료시키지 못함
- 모든 report가 계약된 worktree 내부 경로에 존재
- 금지 명령 실행 0건
- 원본 저장소 변경 0건
- Graph integrity PASS
- 모든 Run이 finalize 또는 명시적 abort

## 11. 현재 제한

### Compatibility bridge

현재는 ProofGraph Kernel이 Graph 상태를 소유한다. Orca Task 상태만으로 Graph 전체를 복구하는 strict native mode가 아니다.

### Local worktree만 지원

Result report를 ProofGraph 프로세스가 직접 안전하게 읽기 때문에, `worktreePath`는 같은 머신에서 접근 가능한 절대 로컬 경로여야 한다. SSH worktree와 Remote Orca Server는 아직 지원하지 않는다. 향후에는 Orca artifact/file transport 또는 content-addressed report protocol이 필요하다.

### Orchestration은 Experimental

Orca CLI의 Orchestration 계약은 변경될 수 있다. 실제 운영에서는 Orca 버전을 고정하고 contract canary를 수행해야 한다.

### Decision gate projection

Worker가 decision gate를 요청하면 현재 attempt는 명시적 `blocked` 결과로 보존된다. Orca gate 해결 후 동일 dispatch를 장시간 재연결하는 완전한 양방향 gate reconciliation은 아직 구현하지 않았다.

### Worktree 수

현재 한 Node attempt마다 새 Orca worktree를 만든다. 대형 Graph에서는 worktree가 많아질 수 있다. 자동 삭제하지 않으며 Orca에서 diff를 검토한 뒤 사람이 archive/delete한다.

### Mutation 미승인

`allow_workspace_mutation=false`가 기본이고 live canary 전에는 변경형 Node를 거부한다. Worktree가 격리되어 있어도 네트워크·자격증명·프로덕션 부작용까지 격리되는 것은 아니다.

## 12. Strict Orca-native 후속 방향

엄격한 Orca-native backend의 목표는 다음과 같다.

```text
Natural language
  ↓
ProofGraph Task Compiler (ephemeral)
  ↓
Logical Graph + policy
  ↓
Orca Task / dependency / dispatch / decision gate
  ↓
Orca is the sole runtime state authority
```

그 단계에서는 별도 daemon·DB·queue·tmux·cron을 만들지 않는다. Orca의 repo/worktree/terminal/task/dispatch/gate/inbox/automation을 권위 있는 상태로 사용하고, ProofGraph는 Graph adequacy·policy·verification reconciliation만 제공한다.

Strict native 전환은 다음 증거 후에만 진행한다.

- 설치된 Orca 버전의 Task dependency 계약 확인
- gate resolve 이후 dispatch 연속성 확인
- Orca 재시작 후 Task/Dispatch replay 확인
- 원격 Orca artifact 전달 방식 확인
- 최소 20건 live canary
- 3-worker 병렬 실행에서 메시지 손실 0건
- stale dispatch 오승격 0건

## 13. 운영 판정

```text
오프라인 Compatibility Bridge 계약       PASS
병렬 메시지 소비 방어                    PASS (fake Orca)
독립 CLI 블랙박스 검증                   PASS
실제 Orca read-only preflight            사용자 Mac에서 필요
실제 Orca 3-worker canary                필요
Workspace mutation                       아직 NO-GO
Remote/SSH Orca                           아직 NO-GO
Strict Orca-native state backend         미구현
```
