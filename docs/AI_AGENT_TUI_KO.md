# AI Agent TUI 개발 그래프와 v1.0.1 실제 구현

## 1. 자연어 명령이 들어오면

사용자가 다음처럼 입력한다고 가정합니다.

```text
AI 에이전트 TUI를 개발하라.
```

ProofGraph는 이 문장을 하나의 장문 프롬프트로 바로 전달하지 않습니다. 먼저 `agent-tui` 템플릿을 자동 선택하고, 복잡도·불확실성·위험도·리서치·구현·검증 조건을 가진 GraphSpec으로 컴파일합니다.

```bash
proofgraph compile \
  "AI 에이전트 TUI를 개발하라"
```

템플릿을 명시해도 동일한 정책을 적용합니다.

```bash
proofgraph compile \
  "AI 에이전트 TUI를 개발하라" \
  --template agent-tui
```

자연어 컴파일 결과는 작업마다 생성되는 동적 그래프입니다. 중요한 제품 기능은 사람이 검토하고 재현할 수 있도록 명시적 GraphSpec 파일도 함께 유지합니다.

```text
examples/graphs/ai-agent-tui.graph.json
```

## 2. GraphSpec 형식

GraphSpec은 JSON으로 정의합니다.

```json
{
  "schema_version": 1,
  "graph_id": "graph_ai_agent_tui_v1",
  "objective": "Develop a secure operator TUI...",
  "entry_node": "triage",
  "nodes": [],
  "edges": [],
  "limits": {
    "max_steps": 100,
    "max_route_visits": 5,
    "max_dynamic_nodes": 16,
    "max_parallel_nodes": 3,
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

각 node에는 다음 계약이 들어갑니다.

```json
{
  "node_id": "verify-adversarial",
  "title": "Adversarially verify the TUI",
  "kind": "verify",
  "role": "verifier",
  "agent_type": "proofgraph-claude:graph-verifier-deep",
  "model_tier": "deep",
  "max_attempts": 5,
  "tool_policy": ["proofgraph", "workspace_read"],
  "metadata": {
    "verification_strength": "deep"
  }
}
```

각 edge는 다음처럼 상태 조건을 선언합니다.

```json
{
  "edge_id": "e-functional-implementation",
  "from": "verify-functional",
  "to": "develop-model",
  "condition": {
    "type": "failure_type",
    "value": "implementation_error"
  },
  "priority": 100
}
```

지원 조건은 제한된 vocabulary만 사용합니다.

```text
always
outcome
route
failure_type
approval
verification
```

임의 JavaScript나 모델이 만든 표현식을 실행하지 않습니다.

## 3. 실제 AI Agent TUI 그래프

```text
triage
 ├─ research-runtime ─┐
 ├─ research-ux ──────┼─▶ plan
 └─ research-safety ──┘
                         │
                         ▼
                   develop-model
                         │
                         ▼
                 develop-renderer
                         │
                         ▼
                develop-controller
                         │
                         ▼
                verify-functional
                   │           │
                 PASS       failure
                   ▼           ├─ implementation_error → develop-model
             verify-adversarial├─ design/requirements → plan
                   │           ├─ evidence_gap → research
                 PASS          └─ security_risk → failed
                   ▼
                synthesize
                   ▼
                 success
```

참조 그래프는 14개 node, 38개 edge, 3개 terminal을 갖습니다. 성공 terminal로 가는 경로는 기능 검증과 적대적 검증을 모두 통과해야 합니다. 반복은 `max_steps`, `max_route_visits`, `max_attempts`, `max_iterations`로 제한합니다.

## 4. GraphSpec 검사와 실행

```bash
proofgraph graph validate \
  examples/graphs/ai-agent-tui.graph.json
```

안전한 Mock Adapter로 Graph Runtime을 검증합니다.

```bash
proofgraph graph run \
  examples/graphs/ai-agent-tui.graph.json \
  --adapter mock
```

Mock 실행은 그래프·상태·라우팅·검증 게이트가 동작함을 확인합니다. Claude, Codex, OpenCode 등 실제 공급자 결과 품질을 증명하지는 않습니다. 실제 Adapter는 해당 버전의 live canary를 통과한 뒤 활성화합니다.

## 5. 구현된 TUI 실행

최신 Graph run을 자동 선택합니다.

```bash
proofgraph tui
```

특정 run을 엽니다.

```bash
proofgraph tui <run_id>
```

CI, 로그 수집, pipe 환경에서는 터미널 제어 문자를 사용하지 않는 snapshot mode를 사용합니다.

```bash
proofgraph tui <run_id> --snapshot
```

화면은 다음 네 영역으로 구성됩니다.

```text
RUNS
GRAPH / AGENTS
INSPECTOR / APPROVALS
EVENTS
```

## 6. 키보드 조작

```text
Tab / → / ←   focus 이동
↑ / k         현재 focus의 이전 run 또는 node
↓ / j         현재 focus의 다음 run 또는 node
p             pause 또는 실제 resume 실행
s             node 하나 실행 후 다시 pause

 a, a          pending approval 승인
 d, d          pending approval 거부
 x, x          run 중단

r             새로고침
?             안전 조작 도움말
q / Ctrl-C    종료
```

승인·거부·중단은 같은 키를 4초 안에 두 번 눌러야 합니다. 승인과 거부는 GraphKernel의 challenge 기반 approval API를 통과하고, 중단은 GraphKernel의 abort API를 사용합니다.

`p`로 paused run을 재개하면 단순히 debugger flag만 바꾸는 것이 아니라 `kernel.resume()`을 호출해 ready node를 실제 실행합니다. `s`는 step budget을 1로 설정한 후 kernel을 실행하고 node 하나가 끝나면 다시 paused 상태로 돌아갑니다.

## 7. 안전 경계

TUI는 제2의 Control Plane이 아닙니다.

```text
조회       → 검증된 state/event/report만 읽음
pause/step → DebuggerController만 사용
resume     → GraphKernel만 사용
approve    → challenge 기반 GraphKernel approval
abort      → GraphKernel abort
```

다음 방어가 적용됩니다.

- `state.json` 직접 수정 금지
- event hash chain과 state digest가 깨진 run은 `integrity_error`로 격리
- ANSI, C0, C1 terminal control sequence 제거
- width와 height에 맞춘 bounded rendering
- non-TTY에서 interactive mode 거부
- 오류·Ctrl-C·정상 종료 모두 raw mode, cursor, alternate screen 복구
- 승인·거부·중단 이중 키 확인
- 기본 상태에서 shell과 workspace mutation 없음

## 8. 검증

```bash
npm test
npm run preflight
npm run verify:tui
```

`verify:tui`는 production module을 import하지 않고 공개 CLI와 persisted artifacts만 사용하여 다음을 확인합니다.

- 한국어 자연어 명령의 `agent-tui` 자동 선택
- 명시적 GraphSpec 정적 검사
- Mock Graph run의 success 및 integrity
- TUI snapshot의 run/node/verifier 표시
- 상태 변조 시 fail-closed 표시
- non-TTY interactive 실행 거부

## 9. 현재 제한

- 로컬 단일 운영자 콘솔이며 원격 multi-user TUI가 아닙니다.
- 실패 재시도는 Graph failure edge가 자동 처리하며, 임의 node를 강제로 재실행하는 수동 retry 키는 제공하지 않습니다.
- JavaScript 문자열 길이를 기준으로 폭을 계산하므로 일부 CJK·emoji 조합의 시각적 cell 폭은 정확하지 않을 수 있습니다.
- 사람 승인은 명시적 이중 키와 challenge를 사용하지만 승인자의 실제 신원을 암호학적으로 증명하지는 않습니다.
- 실제 공급자 Adapter 품질은 Claude/Codex/OpenCode 등의 개별 live canary가 필요합니다.
