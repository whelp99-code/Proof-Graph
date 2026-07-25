# ProofGraph Graph Engineering v1.0

> v1.0 integrates this compiler/runtime with universal adapters, approval-gated worktrees, a debugger, templates, CLI, ESM API, and universal MCP. Claude Code is one host adapter, not the product boundary.

## 1. 정의

ProofGraph에서 Graph Engineering은 여러 에이전트를 많이 호출하는 기술이 아니다.

> 목표를 상태로 표현하고, 역할·위험·검증 결과·남은 예산에 따라 다음 노드와 병렬도를 결정하며, 실패를 적절한 단계로 되돌리고, 승인·종료 조건을 강제하는 제어 시스템이다.

## 2. 세 계층

### v0.3 — Conditional Runtime

그래프의 노드와 에지는 미리 존재하지만 실행 경로가 상태에 따라 달라진다.

```text
verify passed              → synthesize
implementation_error       → develop
design_error               → plan
evidence_gap               → research
security_risk              → human/fail
```

### v0.4 — Adaptive Runtime

작업에 따라 fan-out, 검증 강도, 반복 상한, 모델 tier가 바뀐다.

```text
route = f(complexity, uncertainty, risk, reversibility,
          requires_research, requires_implementation,
          estimated_subtasks, remaining_budget)
```

### v0.5 — Dynamic Compiler

자연어 목표와 명시적 signal을 안전 GraphSpec으로 컴파일한다. 모델이 임의 JavaScript를 생성해 실행하는 방식이 아니라, 제한된 노드·에지·조건 vocabulary에서 서버가 결정론적으로 생성하고 정적 검증한다.

## 3. GraphSpec

핵심 필드:

```json
{
  "graph_id": "graph_...",
  "entry_node": "triage",
  "nodes": [
    {
      "node_id": "verify",
      "kind": "verify",
      "role": "verifier",
      "max_attempts": 4,
      "model_tier": "deep",
      "tool_policy": ["proofgraph", "workspace_read"]
    }
  ],
  "edges": [
    {
      "from": "verify",
      "to": "develop",
      "condition": {
        "type": "failure_type",
        "value": "implementation_error"
      }
    }
  ],
  "limits": {
    "max_steps": 120,
    "max_route_visits": 4,
    "max_dynamic_nodes": 24,
    "max_parallel_nodes": 6,
    "max_iterations": 4
  }
}
```

지원 조건은 arbitrary expression이 아니다.

```text
always
outcome
route
failure_type
approval
verification
```

임의 코드 조건을 허용하지 않기 때문에 route injection과 실행 임의성이 줄어든다.

## 4. 상태기계

노드 상태:

```text
pending → ready → running → succeeded
                         ↘ failed
                         ↘ blocked
pending → waiting_approval → succeeded/blocked
```

Run 상태:

```text
active
waiting_approval
budget_exceeded
failed
finalized
aborted
```

모든 변경은 transaction과 event hash chain에 기록된다.

## 5. 적응형 실패 라우팅

Failure Packet의 `recommended_route`는 조언일 뿐이다. 서버가 `failure_type`, severity, signature 반복 횟수로 실제 경로를 선택한다.

```text
첫 implementation_error       → develop
동일 signature 두 번째        → design_error로 승격 → plan
동일 signature 세 번째        → security_risk로 승격 → human/fail
critical/security_risk         → 즉시 human/fail
budget_exceeded                → partial terminal
```

## 6. 병렬화와 Join

리서치 fan-out 수는 complexity, uncertainty, estimated_subtasks, max_parallel_nodes로 제한된다.

Join은 `any` 또는 `all`이다. 병렬 리서치 뒤의 plan은 해당 shard 목록을 `join_from`으로 가지며, 모든 shard가 완료돼야 ready가 된다.

실행 중 planner가 `pg_graph_expand`를 호출하면 parent→join 직결 edge를 안전한 child fan-out/fan-in으로 교체한다. 전체 그래프는 다시 정적 검증되고 digest·revision이 갱신된다.

## 7. 사람 승인

high/critical, external side effect, compliance-sensitive, irreversible signal은 human route를 만든다.

승인 상태는 approval ID, reason, risk, challenge hash를 저장한다. Skill은 AskUserQuestion 결과를 받아 challenge와 함께 resolve한다.

한계: 같은 Claude host가 challenge를 보고 `human` 역할을 자기신고할 수 있다. 따라서 이것은 사람 신원 인증이 아니라 승인 상태 연속성과 감사 기록이다.

## 8. 권한

기본 compiler는 다음 capability만 생성한다.

```text
proofgraph
web_search
workspace_read
```

`workspace_write`와 `shell`은 기본 정책에서 금지된다. 실행 중 확장에서도 삽입할 수 없다.

Hook은 ready node의 exact `agent_type`만 생성하고, running node와 agent role/tool policy가 일치할 때만 read/search 도구를 허용한다.

## 9. 검증

성공 터미널 도달 조건:

```text
verifier node succeeded
+ output.verification.passed === true
+ synthesize succeeded
+ terminal-success activated
```

정적 검사와 런타임 검사는 서로 다른 역할이다.

```text
정적: topology, reachability, cycle, verifier coverage, permissions, bounds
런타임: actor ownership, claim state, output contract, failure routing, approval, budget
사후: event chain, graph digest, node output/failure hash, report hash
```