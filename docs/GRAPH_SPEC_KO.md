# ProofGraph GraphSpec v1 정의 형식

ProofGraph의 실행 그래프는 **JSON 기반 `GraphSpec v1`**으로 정의합니다. 자연어는 작성 편의를 위한 입력이고, 실제 런타임은 항상 정규화·정적 검증된 GraphSpec만 실행합니다.

```text
자연어 목표
  ↓ 템플릿 매칭 + 신호 평가
Template Profile
  ↓ 결정론적 컴파일
GraphSpec v1 JSON
  ↓ 정적 안전 검사
Graph Runtime
```

## 1. 두 가지 작성 방식

### 자연어 + 안전한 템플릿 프로필

```bash
proofgraph compile "AI 에이전트 TUI를 개발하라"
```

이 문장은 자동으로 `agent-tui` 템플릿과 매칭됩니다. 템플릿은 임의 코드나 임의 노드를 삽입하지 않고 다음 **bounded profile**만 제공합니다.

```json
{
  "template_name": "agent-tui",
  "research_workstreams": ["..."],
  "implementation_workstreams": ["..."],
  "deliverables": ["..."],
  "acceptance_tests": ["..."],
  "non_goals": ["..."]
}
```

컴파일러는 profile과 복잡도·불확실성·위험도·예산 신호를 이용해 허용된 노드와 에지만 생성합니다.

### 명시적 GraphSpec

중요하거나 반복 실행할 개발 흐름은 JSON을 직접 검토하고 버전 관리합니다.

```bash
proofgraph graph validate examples/graphs/ai-agent-tui.graph.json
proofgraph graph run examples/graphs/ai-agent-tui.graph.json --adapter mock
```

## 2. 최소 구조

```json
{
  "schema_version": 1,
  "graph_id": "graph_example_v1",
  "name": "Example development graph",
  "objective": "Implement and independently verify an example feature.",
  "entry_node": "triage",
  "nodes": [
    {
      "node_id": "triage",
      "title": "Classify scope and risk",
      "kind": "triage",
      "role": "system",
      "tool_policy": ["proofgraph"]
    },
    {
      "node_id": "verify",
      "title": "Independently verify the result",
      "kind": "verify",
      "role": "verifier",
      "max_attempts": 4,
      "model_tier": "deep",
      "tool_policy": ["proofgraph", "workspace_read"]
    },
    {
      "node_id": "done",
      "title": "Verified completion",
      "kind": "terminal",
      "role": "system",
      "terminal_status": "success",
      "tool_policy": ["proofgraph"]
    }
  ],
  "edges": [
    {
      "edge_id": "e-triage-verify",
      "from": "triage",
      "to": "verify",
      "condition": { "type": "route", "value": "verify" }
    },
    {
      "edge_id": "e-verify-done",
      "from": "verify",
      "to": "done",
      "condition": { "type": "verification", "value": "passed" }
    }
  ],
  "limits": {
    "max_steps": 120,
    "max_route_visits": 4,
    "max_dynamic_nodes": 24,
    "max_parallel_nodes": 6,
    "max_iterations": 4
  },
  "policy": {
    "require_verification_for_success": true,
    "require_human_for_high_risk": true,
    "allow_workspace_mutation": false,
    "allow_shell": false
  }
}
```

## 3. 제한된 vocabulary

노드 종류:

```text
triage · direct · research · plan · develop
verify · human_approval · synthesize · terminal
```

역할:

```text
system · coordinator · direct · researcher · planner
developer · verifier · human · synthesizer
```

에지 조건:

```text
always
outcome          success | failed | blocked
route            direct | research | plan | develop | verify | human | synthesize | success | partial | failed
failure_type     implementation_error | design_error | requirements_error | evidence_gap |
                 verification_error | security_risk | budget_exceeded | unknown
approval         approved | denied
verification     passed | failed
```

도구 capability:

```text
proofgraph · web_search · workspace_read · workspace_write · shell
```

`workspace_write`와 `shell`은 정책에서 명시적으로 허용하고 승인 경계를 둔 경우에만 사용할 수 있습니다.

## 4. 정적 안전 검사

런타임은 JSON 형식 검사뿐 아니라 다음을 강제합니다.

- entry와 모든 edge가 실제 node를 가리키는가
- 도달 불가능한 node가 없는가
- 성공 terminal로 가는 모든 경로가 verifier를 통과하는가
- high/critical risk에 사람 승인 경계가 있는가
- 모든 cycle에 verifier 또는 human gate가 포함되는가
- 반복·병렬·동적 node·step 상한이 있는가
- 금지된 shell/workspace mutation이 끼어들지 않았는가
- node kind와 role이 호환되는가

그래프 digest는 정규화된 GraphSpec의 SHA-256으로 계산되어 같은 입력의 재현성과 변경 탐지를 지원합니다.

## 5. 기계 판독 스키마

에디터 자동완성과 외부 도구 연동용 JSON Schema:

```text
schemas/graphspec-v1.schema.json
```

JSON Schema는 문서·교환 형식을 위한 보조 계약입니다. **위상, verifier coverage, cycle, 권한과 같은 실행 안전성은 `proofgraph graph validate`가 최종 권위**입니다.
