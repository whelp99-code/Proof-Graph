# ProofGraph Operator TUI 개발 계획서

**기준 버전:** ProofGraph v2.0.0  
**최종 목표:** ProofGraph v3.0.0 Operator TUI GA  
**핵심 원칙:** 한 화면에서 실행 흐름, 현재 위치, 다음 단계, 실패 원인, 루프, 승인·거절, Host 상태와 최종 품질을 실시간으로 확인하고 안전하게 조작한다.

---

## 1. 개발 목표

현재 ProofGraph v2.0.0은 Mission, WorkItem, Failure, Approval, OS Cycle, Event Log를 저장하지만 운영자가 `mission-status`, `mission-report`, `events.jsonl`을 따로 조회하고 JSON을 해석해야 한다. 기능은 있으나 운영 경험이 복잡하다.

다음 개발의 목표는 단순한 로그 뷰어가 아니다.

```text
자연어 목표 입력
   ↓
실행 그래프 생성
   ↓
OpenCode / 기타 Host에서 작업 실행
   ↓
노드 상태와 Edge 이동을 실시간 표시
   ↓
실패 원인과 Loop 경로 표시
   ↓
승인·거절·재시도·중단을 TUI에서 처리
   ↓
검증 결과와 최종 Artifact 확인
```

운영자는 TUI를 열었을 때 5초 안에 다음 일곱 가지 질문에 답할 수 있어야 한다.

1. 지금 무엇이 실행 중인가?
2. 현재 어느 단계인가?
3. 다음 단계는 무엇인가?
4. 무엇이 실패했고 왜 실패했는가?
5. 몇 번째 Loop인가?
6. 사람의 결정이 필요한 항목이 있는가?
7. 최종 완료인지, 복구 완료인지, 부분 완료인지, 실패인지?

---

## 2. 최종 사용자 경험

최종 명령은 다음처럼 단순해야 한다.

```bash
proofgraph tui
```

새 Mission 시작:

```bash
proofgraph tui --new "인증 API를 구현하고 독립 검증하라"
```

OpenCode Host에 연결:

```bash
proofgraph tui --host opencode --project .
```

최종 화면 예시:

```text
┌ ProofGraph Operator ───────────────────────────────────────────────────────────────┐
│ RUN pg_01  ACTIVE   OpenCode CONNECTED   Cycle 1/3   Cost $1.42   Elapsed 08:21  │
├───────────────┬────────────────────────────────────────────┬───────────────────────┤
│ RUNS          │ EXECUTION GRAPH                            │ INSPECTOR             │
│               │                                            │                       │
│ ● pg_01       │ [Triage ✓]                                 │ Node: Verify          │
│   ACTIVE      │      │                                     │ Status: FAILED        │
│   73%         │      ▼                                     │ Attempt: 1/3          │
│               │ [Research ✓]──┐                            │ Failure:              │
│ ○ pg_00       │               ├──▶[Plan ✓]                 │ implementation_error  │
│   COMPLETED   │ [Research ✓]──┘       │                    │                       │
│               │                       ▼                    │ Evidence:             │
│ ! pg_99       │                  [Develop ↺ 2]              │ auth.test.ts:42       │
│   APPROVAL    │                       │                    │                       │
│               │                       ▼                    │ Next route: Develop   │
│               │                  [Verify ! 1] ──────┐       │ Loop: 2/3             │
│               │                       ▲            │       │                       │
│               │                       └────────────┘       │ [R] Retry [A] Approve │
├───────────────┴────────────────────────────────────────────┼───────────────────────┤
│ TIMELINE                                                   │ APPROVAL QUEUE        │
│ 12:01:02 Develop completed                                 │ 1 pending             │
│ 12:01:05 Verify failed: implementation_error               │ deploy-production     │
│ 12:01:05 Route changed: Verify → Develop, iteration 2/3    │ [Y] Approve [N] Deny  │
├────────────────────────────────────────────────────────────┴───────────────────────┤
│ [G] Graph [O] Org [T] Timeline [F] Failures [L] Logs [/] Search [?] Help [Q] Quit │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 최종 화면의 필수 View

| View | 목적 |
|---|---|
| Dashboard | 전체 Mission·OS Run과 건강 상태 확인 |
| Execution Graph | 노드·Edge·현재 경로·Loop 실시간 확인 |
| Organization | 부서·팀·역할·위임 관계 확인 |
| Timeline | 모든 이벤트의 시간순 흐름 확인 |
| Failure Center | 실패 유형, 증거, 재시도 경로, 해결 여부 확인 |
| Approval Queue | 승인·거절·사유 입력·결정 이력 관리 |
| Host Sessions | OpenCode 세션, 모델, 도구, 파일 변경, 연결 상태 확인 |
| Artifacts | 후보·검증됨·거절됨 Artifact 확인 |
| OS Cycles | 자율 Cycle, Council 결정, 개선 제안 확인 |
| Audit & Integrity | 이벤트 해시, 상태 무결성, 변조 탐지 확인 |

---

## 3. 제품 불변조건

TUI 개발 과정에서도 다음 규칙은 절대 약화하지 않는다.

### 3.1 UI는 Runtime을 직접 수정하지 않는다

TUI가 `state.json`이나 `events.jsonl`을 직접 수정하면 안 된다. 모든 조작은 Control Plane API를 통한다.

### 3.2 승인과 거절은 명시적 사람 행동이다

모델이나 Host가 승인 API를 호출할 수 없다. 승인·거절·중단은 Operator Session과 감사 기록을 요구한다.

### 3.3 실패는 삭제하지 않고 해결 상태를 분리한다

과거 실패와 현재 미해결 실패를 분리한다.

```text
historical_failures
unresolved_failures
resolved_failures
completed_with_recovery
```

### 3.4 모든 Loop는 상한과 이유를 가진다

각 Loop는 다음 필드를 가진다.

```text
loop_id
failure_type
source_node
target_node
iteration
max_iterations
entered_at
exit_reason
```

### 3.5 연결이 끊겨도 실행은 계속된다

TUI는 클라이언트다. TUI가 종료되거나 터미널이 끊겨도 `proofgraphd`와 Worker는 실행을 계속해야 한다.

### 3.6 재접속 시 전체 상태를 복구한다

SSE 이벤트 일부를 놓쳐도 최신 Snapshot과 이후 Event Sequence를 이용해 화면을 완전히 복구해야 한다.

---

## 4. 목표 아키텍처

```text
┌──────────────────────────────────────────────────────────────────┐
│                         User Interfaces                          │
│                                                                  │
│  proofgraph tui       proofgraph cli       OpenCode Plugin       │
└──────────────────────────────┬───────────────────────────────────┘
                               │ REST Commands + SSE Events
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    ProofGraph Control Plane                      │
│                         proofgraphd                              │
│                                                                  │
│ Run Registry       Graph Projection       Approval Service       │
│ Command Router     Event Stream           Host Registry          │
│ State Reducer      Failure/Loop Engine    Artifact Registry      │
│ Auth/Policy        Snapshot Service       Audit/Integrity        │
└───────────────┬───────────────────────────────┬──────────────────┘
                │                               │
                ▼                               ▼
┌────────────────────────────┐       ┌─────────────────────────────┐
│ ProofGraph Runtime         │       │ Host Adapters               │
│ Mission / OS / Queue       │       │                             │
│ Graph Compiler             │       │ OpenCode HTTP/SSE           │
│ Organization Runtime       │       │ v1.1 Host Bridge            │
│ Verifier / Governance      │       │ Pi / Orca future adapters   │
└──────────────┬─────────────┘       └──────────────┬──────────────┘
               │                                     │
               ▼                                     ▼
┌────────────────────────────┐       ┌─────────────────────────────┐
│ SQLite WAL + Append Log    │       │ OpenCode Sessions / Agents │
│ Snapshots / Artifacts      │       │ Tools / File changes       │
└────────────────────────────┘       └─────────────────────────────┘
```

### 기술 선택

| 영역 | 선택 | 이유 |
|---|---|---|
| 언어 | TypeScript / Node.js 20+ | 현재 v2.0.0 Node ESM 런타임과 같은 생태계 유지 |
| TUI | Ink + React | 컴포넌트 기반 상태 UI, 키보드 입력, 터미널 Flexbox 지원 |
| Graph Layout | `@dagrejs/dagre` | 방향성 Graph 자동 배치; 좌표를 문자 셀로 변환 가능 |
| Local Store | SQLite WAL + 기존 append-only event log | 조회·필터·다중 클라이언트와 재시작 복구 개선 |
| Command API | REST/JSON | 승인·재시도·중단 등 명령의 감사와 idempotency에 적합 |
| Event API | SSE | 단방향 실시간 이벤트와 재접속 구현이 단순함 |
| Host 연동 | OpenCode `serve` HTTP API + SSE Event | 세션·도구·상태 이벤트를 공식 서버 표면으로 수집 |
| Telemetry | OpenTelemetry core conventions + `proofgraph.*` 버전 스키마 | 외부 관측 도구 연동 가능; GenAI 필드는 실험 버전으로 격리 |

---

## 5. 상태와 이벤트 표준화

TUI 개발보다 먼저 데이터 계약을 고정해야 한다.

### 5.1 Run 상태

기존 상태를 사용자 친화적으로 재정의한다.

```text
planned
queued
active
paused
waiting_approval
completed_clean
completed_with_recovery
partial
failed
denied
aborted
```

호환성 매핑:

| 기존 상태 | 새 표시 상태 |
|---|---|
| `completed` + 실패 0 | `completed_clean` |
| `completed` + 해결된 과거 실패 존재 | `completed_with_recovery` |
| `failed` + approval denied | `denied` |
| `partial` | `partial` |
| `waiting_approval` | `waiting_approval` |

### 5.2 Node 상태

```text
blocked
pending
ready
running
paused
waiting_approval
completed
failed
skipped
cancelled
```

### 5.3 표준 Event Envelope

```json
{
  "schema_version": 2,
  "event_id": "evt_...",
  "sequence": 184,
  "occurred_at": "2026-07-26T12:00:00.000Z",
  "run_type": "mission",
  "run_id": "mission_...",
  "parent_run_id": "osrun_...",
  "mission_id": "mission_...",
  "node_id": "work_verify",
  "edge_id": "verify_to_develop",
  "host": "opencode",
  "host_session_id": "ses_...",
  "type": "route.changed",
  "actor": {
    "type": "runtime",
    "id": "company-runtime"
  },
  "status_before": "failed",
  "status_after": "pending",
  "attempt": 2,
  "loop": {
    "loop_id": "loop_...",
    "iteration": 2,
    "max_iterations": 3
  },
  "severity": "warning",
  "summary": "Verify failed; routed back to Develop",
  "data": {},
  "integrity": {
    "previous_hash": "...",
    "event_hash": "..."
  }
}
```

### 5.4 반드시 추가할 이벤트

```text
run.queued
run.paused
run.resumed
run.cancel_requested
run.cancelled

node.ready
node.started
node.progress
node.output
node.completed
node.failed
node.blocked
node.retry_scheduled

route.selected
route.changed

loop.entered
loop.iteration
loop.exited
loop.exhausted

approval.requested
approval.approved
approval.denied
approval.expired

host.connected
host.disconnected
host.session.created
host.session.status
host.tool.started
host.tool.completed
host.permission.requested
host.permission.replied

artifact.candidate_created
artifact.verified
artifact.rejected

run.completed_clean
run.completed_with_recovery
run.partial
run.failed
run.denied
run.aborted

integrity.warning
integrity.failed
```

---

# 6. 단계별 개발 계획

## Phase 0 — 운영 UX 계약 고정

**목적:** 코드를 추가하기 전에 화면·용어·상태·키 조작을 확정한다.

### 구현 항목

- TUI 정보 구조 확정
- Run/Node/Approval/Failure/Loop 상태 사전 확정
- 화면 와이어프레임 작성
- 키보드 조작표 작성
- 최소 터미널 크기와 축소 모드 정의
- 초보자 모드와 전문가 모드 정의
- 접근성 규칙 정의: 색상만으로 상태를 구분하지 않음

### 산출물

```text
docs/tui/UX_SPEC_KO.md
docs/tui/SCREEN_WIREFRAMES.md
docs/tui/STATUS_DICTIONARY.md
docs/tui/KEYMAP.md
```

### 종료 게이트

운영자는 목업만 보고 현재 단계, 실패, Loop, 승인 대기를 구분할 수 있어야 한다.

---

## Phase 1 — v2.0.1 Observability Contract

**목적:** 기존 state/event 구조를 TUI가 안정적으로 소비할 수 있는 표준으로 바꾼다.

### 구현 항목

1. Event Envelope v2 추가
2. 기존 이벤트를 v2 이벤트로 변환하는 Compatibility Adapter 구현
3. `route.changed`, `loop.*`, `node.progress` 추가
4. `historical_failures`, `unresolved_failures`, `resolved_failures` 분리
5. `completed_with_recovery` 계산 추가
6. Mission Report에 `route_history`, `current_nodes`, `next_nodes`, `loops` 포함
7. OS Report에 현재 Mission·현재 Cycle·다음 Governance Action 포함
8. 이벤트 Sequence와 Snapshot Version 추가

### 주요 코드 변경

```text
runtime/events/event-envelope.ts
runtime/events/event-types.ts
runtime/events/compat-v1.ts
runtime/projections/run-reducer.ts
runtime/projections/graph-projection.ts
runtime/company/company-runtime.mjs
runtime/os/autonomous-os.mjs
```

### 테스트

- 동일 Event Stream으로 동일 Projection 생성
- 중복 Event를 적용해도 상태 불변
- Sequence 누락 탐지
- 과거 v2.0.0 Run 읽기 호환
- 복구 완료와 완전 완료 구분
- Loop iteration과 route 변경 정확성

### 종료 게이트

TUI 없이도 하나의 `run-view.json`만 보면 현재 노드, 다음 노드, Loop, 미해결 실패, 승인 대기를 알 수 있어야 한다.

---

## Phase 2 — v2.1.0 Control Plane (`proofgraphd`)

**목적:** 파일 직접 조회를 제거하고 모든 UI와 Host가 하나의 API를 사용하도록 한다.

### 구현 항목

1. `proofgraphd serve` 데몬
2. SQLite WAL 기반 Run Index와 Projection Store
3. 기존 append-only event log 유지
4. Snapshot + Event Replay
5. REST Command API
6. SSE Event Stream
7. idempotency key
8. optimistic concurrency / expected version
9. 로컬 Operator Session
10. API 감사 로그
11. Runtime·Host health check

### 최소 API

```text
GET    /v1/health
GET    /v1/runs
POST   /v1/runs
GET    /v1/runs/:runId
GET    /v1/runs/:runId/graph
GET    /v1/runs/:runId/timeline
GET    /v1/runs/:runId/artifacts
GET    /v1/runs/:runId/integrity
GET    /v1/events?after=<sequence>

POST   /v1/runs/:runId/pause
POST   /v1/runs/:runId/resume
POST   /v1/runs/:runId/abort
POST   /v1/nodes/:nodeId/retry

GET    /v1/approvals
POST   /v1/approvals/:approvalId/approve
POST   /v1/approvals/:approvalId/deny

GET    /v1/hosts
POST   /v1/hosts/opencode/attach
POST   /v1/hosts/:hostId/detach
```

### 안전 규칙

- 승인·거절·중단은 Operator Session 필요
- 모든 명령은 reason과 command ID 저장
- 같은 명령을 재전송해도 한 번만 적용
- stale version 명령은 409로 거부
- TUI 종료 시 Runtime 중단 금지

### 테스트

- 데몬 재시작 후 상태 복구
- SSE 끊김 후 `Last-Event-ID` 재연결
- 두 TUI 동시 접속
- 중복 approve 방지
- pause와 complete 경쟁 조건
- DB 잠금 및 비정상 종료 복구
- API 권한 우회 적대적 테스트

### 종료 게이트

운영자가 더 이상 `state.json`과 `events.jsonl`을 직접 읽지 않아도 모든 상태·명령을 API로 처리할 수 있어야 한다.

---

## Phase 3 — v2.2.0 Read-only TUI MVP

**목적:** 조작보다 먼저 ‘한눈에 보이는 관제 화면’을 완성한다.

### 구현 항목

1. Ink 기반 TUI Shell
2. Run 목록
3. 실행 Graph ASCII Renderer
4. Node Inspector
5. 실시간 Timeline
6. Failure Center
7. Approval Queue 읽기 전용
8. Host 연결 상태
9. 자동 재연결
10. 터미널 Resize 대응
11. 검색·필터
12. Snapshot 로딩 화면과 오류 화면

### TUI 프로젝트 구조

```text
packages/operator-tui/
├─ src/app.tsx
├─ src/api/control-plane-client.ts
├─ src/state/store.ts
├─ src/screens/
│  ├─ dashboard.tsx
│  ├─ execution-graph.tsx
│  ├─ organization.tsx
│  ├─ timeline.tsx
│  ├─ failures.tsx
│  ├─ approvals.tsx
│  └─ artifacts.tsx
├─ src/components/
│  ├─ graph-canvas.tsx
│  ├─ node-card.tsx
│  ├─ edge-layer.tsx
│  ├─ status-badge.tsx
│  ├─ inspector.tsx
│  └─ command-palette.tsx
└─ src/layout/dagre-terminal-layout.ts
```

### Graph 표시 규칙

| 기호 | 의미 |
|---|---|
| `○` | 대기 |
| `◇` | 준비 |
| `●` | 실행 중 |
| `✓` | 완료 |
| `!` | 실패 |
| `↺` | Loop 참여 |
| `⌛` | 승인 대기 |
| `⊘` | 차단 또는 취소 |

색상은 보조 정보이며 기호와 텍스트만으로도 상태를 이해할 수 있어야 한다.

### 대형 Graph 처리

- Department·Shard·완료 Group 접기
- 현재 경로 중심 자동 포커스
- Semantic Zoom: compact / normal / detail
- 화면 밖 Node virtualization
- 1,000 Node 전체를 한 번에 그리지 않음

### 테스트

- 80x24 최소 화면
- 120x40 권장 화면
- terminal resize 연속 테스트
- 1,000 Node Graph
- 10,000 Event Timeline
- 이벤트 폭주 시 화면 응답 유지
- TUI crash 후 Runtime 무영향

### 종료 게이트

JSON이나 별도 Terminal 없이 TUI만으로 현재 단계, 다음 단계, 실패 원인, Loop 횟수, 승인 대기를 확인할 수 있어야 한다.

---

## Phase 4 — v2.3.0 Interactive Operator Actions

**목적:** 승인·거절·재시도·중단을 TUI 안에서 안전하게 수행한다.

### 구현 항목

- Mission 생성 Wizard
- Pause / Resume
- Node Retry
- Mission Abort
- Approval Approve / Deny
- OS Cycle 승인·거절
- 이유 입력 Dialog
- 위험도와 예상 영향 표시
- 명령 실행 전 Dry Preview
- 실행 결과 Toast와 Timeline 기록
- Undo 가능한 UI 상태와 Runtime 명령의 명확한 분리

### 키 조작

```text
N       새 Mission
P       Pause / Resume
R       선택 Node 재시도
A       Approval Queue 열기
Y       승인
N       거절
X       Mission 중단
G       Graph View
O       Organization View
T       Timeline
F       Failure Center
L       Host Logs
/       검색
Ctrl+K  Command Palette
?       도움말
Q       TUI 종료; Runtime은 계속 실행
```

위험 명령은 단일 키로 즉시 실행하지 않는다.

```text
선택
→ 영향 Preview
→ 사유 입력
→ 최종 확인
→ API 명령
→ Event 확인
```

### 승인 UX 개선

기존 Challenge 문자열을 사용자가 직접 복사하지 않는다. TUI가 Control Plane의 Operator Session을 통해 승인 요청과 연결한다. 화면에는 다음만 표시한다.

```text
누가 요청했는가
무엇을 실행하려는가
변경 범위
위험도
가역성
예상 비용
Rollback 계획
독립 Verifier 의견
```

### 테스트

- 승인 Replay
- 두 Operator의 동시 결정
- 승인 직전 Proposal 변경
- stale retry
- abort와 complete 경쟁
- 모델이 Operator API를 직접 호출하는 시도
- 확인 Dialog 우회

### 종료 게이트

운영자가 TUI를 떠나지 않고 실행 생명주기를 관리하되, 모델이 사람 권한을 획득할 수 없어야 한다.

---

## Phase 5 — v2.4.0 OpenCode Live Host Bridge

**목적:** OpenCode의 세션·Agent·Tool 활동을 ProofGraph Graph와 실시간 연결한다.

### 구성

```text
OpenCode TUI / opencode serve
       │
       ├─ HTTP API
       ├─ SSE Event Stream
       └─ OpenCode Plugin Events
               │
               ▼
ProofGraph OpenCode Adapter
       │
       ├─ Session ↔ WorkItem binding
       ├─ Tool event normalization
       ├─ Permission event normalization
       ├─ Token/cost/latency metrics
       └─ file diff / diagnostics references
               │
               ▼
proofgraphd Event Bus
               │
               ▼
Operator TUI
```

### 구현 항목

1. OpenCode server health 확인
2. OpenCode session 생성·연결
3. ProofGraph WorkItem과 OpenCode Session ID 바인딩
4. OpenCode SSE 재연결
5. `session.status`를 Node 상태로 매핑
6. `tool.execute.before/after`를 Inspector와 Timeline에 표시
7. `permission.asked/replied`를 Host Permission 항목으로 표시
8. file diff와 diagnostics 참조
9. Host timeout·disconnect·reconnect
10. OpenCode Plugin Toast 연동

### 화면 표시

```text
Node: Develop
Host: OpenCode
Session: ses_123
Agent: build
Model: provider/model
Current Tool: edit
Files changed: 3
Tests: running
Tokens: 14,320
Host latency: 218 ms
```

### OpenCode 측 명령

```text
/pg-status
/pg-flow
/pg-approvals
/pg-report
```

OpenCode Plugin은 알림과 컨텍스트 연결을 담당한다. 승인·거절의 최종 권한은 독립 ProofGraph TUI 또는 외부 Operator API에 유지한다.

### 테스트

- OpenCode process crash
- SSE event loss
- session reconnect
- 같은 Session을 두 WorkItem에 연결하는 시도
- tool event 순서 역전
- permission request와 ProofGraph approval 혼동 방지
- Host에서 completed를 보고했지만 Verifier가 실패한 경우

### 종료 게이트

OpenCode에서 수행 중인 작업이 ProofGraph Graph Node 안에 실시간으로 표시되고, Host 완료와 ProofGraph 검증 완료를 명확히 구분해야 한다.

---

## Phase 6 — v2.5.0 Advanced Graph & Organization Views

**목적:** 복잡한 조직·Mission·OS Cycle을 한눈에 이해하도록 시각화한다.

### Execution Graph

- 현재 경로 Highlight
- 조건부 Edge Label
- 실패 Return Edge
- Loop iteration badge
- Join barrier 진행률
- Dynamic fan-out Group
- Critical Path
- 예상 다음 Route

### Organization Graph

```text
Executive Office
├─ Research Department
│  ├─ Primary Researcher
│  └─ Secondary Researcher
├─ Engineering
│  ├─ Planner
│  └─ Developer
└─ Independent Quality
   └─ Verifier
```

각 Role에 표시:

```text
현재 WorkItem
Host Session
권한 등급
예산 사용량
성공/실패 횟수
Verifier 독립성
위임 Token 상태
```

### OS Cycle View

```text
Cycle 1 ── failed ──▶ Council: retry
                        │
                        ▼
Cycle 2 ── approval ─▶ approved
                        │
                        ▼
Cycle 3 ── completed_clean
```

### Failure Center

실패를 다음 기준으로 Grouping한다.

```text
미해결 / 해결됨 / 반복됨
구현 / 설계 / 요구사항 / 근거 / 보안 / Host
발생 단계
담당 역할
반복 횟수
권장 Route
```

### 종료 게이트

대규모 Graph에서도 운영자가 현재 병목, 반복 원인, 승인 지점, 조직별 책임을 빠르게 식별할 수 있어야 한다.

---

## Phase 7 — v3.0.0 Operator TUI GA

**목적:** 실환경 운영에 사용할 수 있는 안정성과 배포 체계를 완성한다.

### 기능 완성

- Mission과 OS Run 생성·실행·관찰·제어
- OpenCode 연결과 자동 복구
- Graph·Organization·Timeline·Approval 통합
- 로컬 다중 Run 관리
- Profile과 사용자 설정
- Keymap 사용자화
- Theme와 monochrome 모드
- Artifact export
- 진단 Bundle 생성

### 안정화

- macOS, Linux, WSL 검증
- 터미널 호환성 검증
- 장기 실행 검증
- 1,000 Logical Node 검증
- 100,000 Event Replay 검증
- Control Plane 재시작 복구
- TUI 다중 접속
- Host 다중 세션
- 데이터 마이그레이션
- Backup / Restore

### 배포 명령

```bash
npm install -g @proofgraph/operator
proofgraphd serve
proofgraph tui
```

또는 단일 명령:

```bash
proofgraph start
```

`proofgraph start`는 다음을 수행한다.

```text
Control Plane 확인 또는 시작
→ OpenCode Host 확인 또는 연결
→ TUI 실행
→ 기존 Active Run 복구
```

### 최종 출시 게이트

```text
기능 테스트                   PASS
적대적 테스트                 PASS
독립 블랙박스                 PASS
TUI snapshot / interaction    PASS
OpenCode live canary           PASS
Approval bypass                0
Verifier bypass                0
Event loss                     0
State recovery                 100%
Unresolved silent failure      0
```

---

## 7. 개발 PR 순서

대형 PR 하나로 구현하지 않는다.

```text
PR-01 Status Dictionary and Event Envelope v2
PR-02 Projection Reducer and v2.0 Compatibility Adapter
PR-03 route.changed / loop.* / recovery semantics
PR-04 proofgraphd skeleton and Health API
PR-05 SQLite Projection Store and Event Replay
PR-06 REST Commands and SSE Stream
PR-07 TUI shell, Run List, Connection State
PR-08 Execution Graph read-only renderer
PR-09 Inspector, Timeline, Failure Center
PR-10 Approval Queue read-only
PR-11 Operator Commands and Confirmation Dialogs
PR-12 OpenCode HTTP/SSE Adapter
PR-13 OpenCode Session ↔ WorkItem Binding
PR-14 Organization and OS Cycle Views
PR-15 Large Graph virtualization and performance
PR-16 Migration, packaging, GA verification
```

각 PR은 다음을 포함해야 한다.

```text
코드
단위 테스트
통합 테스트
적대적 테스트
문서
변경된 상태 계약 또는 API 계약
Rollback 방법
```

---

## 8. 테스트 전략

### 8.1 상태·이벤트 검증

- 모든 Event가 Sequence를 가짐
- Event 누락·중복·역순 탐지
- Snapshot과 Replay 결과 일치
- v2.0.0 데이터 마이그레이션
- 과거 실패와 미해결 실패 구분

### 8.2 TUI 상호작용 검증

- 키보드 Navigation
- Focus 이동
- Dialog 취소
- 터미널 Resize
- 느린 Event Stream
- Event Burst
- 잘못된 Unicode width
- 색상 없는 터미널

### 8.3 운영 경쟁 조건

- Node 완료와 Abort 동시 발생
- Approval과 Proposal 변경 동시 발생
- Pause와 Retry 동시 발생
- 두 Operator가 같은 Approval 결정
- TUI reconnect 중 상태 변경

### 8.4 OpenCode 통합

- OpenCode health failure
- Session 생성 실패
- SSE 재연결
- Tool start만 있고 finish가 없는 경우
- OpenCode completed, ProofGraph verifier failed
- Permission 요청과 Human Approval 분리

### 8.5 적대적 검증

- 모델의 Operator API 호출
- 승인 Replay
- stale command
- 이벤트 위조
- state 직접 변조
- Host session 탈취
- Graph Node ID injection
- terminal escape sequence injection
- 로그를 이용한 TUI command injection
- 대형 payload로 UI 정지 유도

---

## 9. 성능 및 UX 완료 기준

| 항목 | 목표 |
|---|---:|
| 로컬 Event → 화면 반영 p95 | 500ms 이하 |
| TUI 재접속 후 최신 상태 복구 | 2초 이내 |
| 1,000 Node Graph 첫 표시 | 2초 이내, Group collapse 사용 |
| 10,000 Event 검색 | 1초 이내 |
| 유휴 상태 CPU | 2% 이하 목표 |
| 일반 실행 메모리 | 250MB 이하 목표 |
| 승인·거절 완료 | 3단계 이하 조작 |
| 현재 Node 식별 | 5초 이내 사용자 테스트 |
| Loop 원인 식별 | 10초 이내 사용자 테스트 |

이는 개발 목표이며 실제 릴리스 검증에서 측정값으로 교체한다.

---

## 10. 현재 v2.0.0에서 가장 먼저 수정할 항목

우선순위는 다음이다.

### P0

1. `route.changed`와 `loop.*` 이벤트 추가
2. `completed_with_recovery`와 미해결 실패 계산
3. Mission Report에 route·loop·current/next node 추가
4. Event Envelope v2와 sequence 추가
5. TUI가 파일을 직접 읽지 않도록 `proofgraphd` API 추가

### P1

1. Read-only TUI
2. Approval Queue
3. Pause·Resume·Retry·Abort
4. OpenCode SSE Adapter
5. Host Session ↔ WorkItem Binding

### P2

1. Organization Graph
2. OS Cycle Graph
3. 대형 Graph virtualization
4. OpenTelemetry export
5. Remote team mode

---

## 11. 최종 완료 정의

최종 TUI 개발은 화면이 예쁘게 보이는 것으로 완료하지 않는다.

다음 작업이 모두 TUI에서 가능해야 한다.

```text
새 Mission 생성
OpenCode Host 연결
실행 Graph 실시간 확인
현재 Node와 다음 Route 확인
실패 증거 확인
Loop 횟수·한도 확인
사람 승인·거절
Pause·Resume·Retry·Abort
Artifact와 Verifier 결과 확인
OS Cycle과 Council 결정 확인
무결성 검사 확인
완료 상태 구분
```

최종 완료 상태는 다음 중 하나로 반드시 명확하게 표시한다.

```text
COMPLETED CLEAN
COMPLETED WITH RECOVERY
PARTIAL
FAILED
DENIED
ABORTED
WAITING APPROVAL
```

ProofGraph Operator TUI의 핵심 가치는 다음 한 문장으로 정의한다.

> 운영자가 JSON과 여러 터미널을 해석하지 않아도, 하나의 화면에서 AI 조직의 전체 실행 흐름을 이해하고 안전하게 통제할 수 있게 한다.

---

## 19. 구현 기준선 및 릴리스 판정

이 구현은 `ProofGraph v2.0.0`의 109개 회귀 테스트를 기준선으로 사용한다.

단계별 코드 버전:

```text
v2.0.1  Observability Contract
v2.1.0  Control Plane
v2.2.0  Read-only Operator TUI
v2.3.0  Interactive Operator Actions
v2.4.0  OpenCode Live Observability Bridge
v2.5.0  Advanced Graph Views
v3.0.0  Operator TUI GA packaging
```

최종 릴리스 판정은 다음을 모두 만족해야 한다.

```text
기존 v2.0.0 회귀 테스트 전부 통과
새 Operator 테스트 전부 통과
권한·승인·경로·SSE 적대적 테스트 통과
Control Plane 재시작 후 projection 복구
TUI snapshot에서 graph/loop/approval 식별 가능
1,000-node graph 렌더링 제한 내 완료
OpenCode fake server HTTP/SSE 통합 통과
재추출 패키지 검증 통과
실제 OpenCode canary는 별도 명시
```

---

## 20. 2026-07-26 구현 완료 결과

| 단계 | 구현 결과 |
|---|---|
| Phase 0 UX Contract | 완료 |
| v2.0.1 Observability Contract | 완료 |
| v2.1.0 Control Plane | 완료 |
| v2.2.0 Read-only TUI | 완료 |
| v2.3.0 Interactive Actions | 완료 |
| v2.4.0 OpenCode Offline Integration | 완료 |
| v2.5.0 Advanced Graph Views | 완료 |
| v3.0.0 Operator Packaging | 완료 |

검증:

```text
자동 시험                   149/149 PASS
기존 독립 블랙박스            18/18 PASS
Operator 독립 블랙박스        15/15 PASS
Coverage                     95.69 / 75.85 / 90.22
Preflight                    11 PASS / 0 FAIL / 2 SKIP
```

남은 외부 게이트:

```text
인증된 OpenCode live canary
Hermes v1.1.0 exact-tree merge
```
