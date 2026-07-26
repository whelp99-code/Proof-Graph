# ProofGraph Operator v3.0.0 아키텍처

## 전체 계층

```text
User / Operator
      │
      ▼
Operator TUI / CLI
      │ REST command + SSE projection
      ▼
proofgraphd Control Plane
├─ Run Registry
├─ Projection Engine
├─ Approval Service
├─ Idempotent Command Ledger
├─ Host Registry
├─ SSE Event Gateway
└─ Integrity Gateway
      │
      ├──────────────────────┐
      ▼                      ▼
Company / OS Runtime      OpenCode Host
├─ Mission                ├─ HTTP/SSE Client
├─ WorkItem               ├─ Observer Plugin
├─ Graph Port             └─ proofgraph.host.v1 Bridge
├─ Verifier
├─ Artifact
└─ Governance
      │
      ▼
HashChainStore
├─ state.json
└─ events.jsonl
```

## 데이터 소유권

| 계층 | 소유 정보 |
|---|---|
| Runtime | authoritative state, graph, approvals, artifacts, event chain |
| Projection | UI용 현재/다음 Node, 상태 분류, Loop, Failure 분리 |
| Control Plane | 명령 인증, idempotency, SSE, Host 연결 |
| TUI | 화면 상태와 선택 위치만 보유 |
| OpenCode Plugin | 관측 이벤트 전송만 수행 |

TUI가 Runtime 파일을 직접 수정하지 않으므로 표시 계층이 검증·승인 정책을 우회할 수 없다.

## Observability Contract v2

Mission projection:

```text
run_id / objective
raw_status / display status
quality_gate_passed
progress
current_node_ids / next_node_ids
graph.nodes / graph.edges
loops / loop_summary
failures.historical/resolved/unresolved
approvals.pending/decided
organization
artifacts
host
operator
timeline
projection digest
```

## Event flow

```text
Runtime mutation
→ atomic state revision
→ hash-chained event
→ projection version 증가
→ Control Plane poll
→ SSE run.updated + raw event
→ TUI render
```

SSE가 끊기면 TUI는 재접속하고 최신 projection snapshot으로 복구한다. Runtime 상태는 SSE에 의존하지 않는다.

## Graph Rendering

Dependency를 이용해 level을 계산하고 터미널 셀에 배치한다. Retry Edge는 별도 하단에 표시한다. 대형 그래프는 현재·다음·실패 Node를 우선 보존하고 완료 Node를 접어 최대 표시 수를 제한한다.

## 프로세스

```text
proofgraph start
├─ 기존 proofgraphd health 확인
├─ 없으면 detached proofgraphd 실행
├─ TUI 연결
└─ TUI 종료 후 daemon 유지

proofgraph stop
└─ Operator 인증 shutdown API
```
