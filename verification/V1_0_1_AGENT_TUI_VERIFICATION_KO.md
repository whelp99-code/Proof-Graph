# ProofGraph v1.0.1 AI Agent TUI 구현·검증 보고서

검증일: 2026-07-25  
릴리스 게이트: **PASS_OFFLINE_VENDOR_CANARY_REQUIRED**

## 1. 실제 사용자 명령

```text
AI에인전트 TUI를 개발하라
```

ProofGraph는 이 문장을 단일 장문 프롬프트로 바로 전달하지 않습니다.

```text
자연어
→ bounded template profile 선택
→ GraphSpec v1 JSON 컴파일
→ 정적 안전 검사
→ 조건부 Graph Runtime
→ 독립 검증
→ TUI 운영 화면
```

- 자동 선택 템플릿: `agent-tui`
- 선택 방식: `auto`
- 오탈자 포함 매칭 키워드: `ai에인전트 tui`
- 기계 판독 스키마: `schemas/graphspec-v1.schema.json`
- 최종 권위 검사: `proofgraph graph validate`

## 2. 그래프 정의 형식

실행 그래프는 JSON 기반 **GraphSpec v1**입니다. 자연어는 작성 입력이며 런타임은 정규화·검증된 GraphSpec만 실행합니다.

```json
{
  "schema_version": 1,
  "graph_id": "graph_ai_agent_tui_v1",
  "entry_node": "triage",
  "nodes": [],
  "edges": [],
  "limits": {},
  "policy": {
    "require_verification_for_success": true,
    "require_human_for_high_risk": true,
    "allow_workspace_mutation": false,
    "allow_shell": false
  }
}
```

임의 JavaScript 조건은 허용하지 않습니다. node kind와 edge condition은 제한된 vocabulary를 사용하고, 성공 경로의 verifier coverage·cycle 종료 경계·권한·예산은 런타임이 별도로 검사합니다.

## 3. 자연어 컴파일 결과

| 항목 | 결과 |
|---|---:|
| 템플릿 | `agent-tui` |
| Node | **15** |
| Edge | **58** |
| 병렬 research node | **6** |
| 사람 승인 gate | **있음** |
| 검증 강도 | `deep` |
| Graph digest | `4e943669520e4bd5d538ca7a62da0acf4657c5df7050acbd56acfc8fa6c72821` |

실제 흐름은 `waiting_approval → explicit approve → resume → finalized/success`로 완료됐습니다.

| 항목 | 결과 |
|---|---:|
| Run ID | `pg_4ff04e488efd0c1572a5e323` |
| 최초 상태 | `waiting_approval` |
| 승인 | `approved` |
| 최종 상태 | `finalized` |
| Terminal | `success` |
| Quality gate | `true` |
| Integrity | `true` |

## 4. 사람이 검토하는 명시적 참조 그래프

파일: `examples/graphs/ai-agent-tui.graph.json`

```text
triage
 ├─ research-runtime ─┐
 ├─ research-ux ──────┼─▶ plan
 └─ research-safety ──┘
                         ↓
                   develop-model
                         ↓
                 develop-renderer
                         ↓
                develop-controller
                         ↓
                verify-functional
                   │          │
                 PASS       failure
                   ↓          ├ implementation_error → develop-model
             verify-adversarial├ design/requirements → plan
                   │          ├ evidence_gap → research
                 PASS         └ security_risk → failed
                   ↓
                synthesize
                   ↓
                 success
```

| 항목 | 결과 |
|---|---:|
| Graph ID | `graph_ai_agent_tui_v1` |
| Node | **14** |
| Edge | **38** |
| 제한된 cycle | **1** |
| Graph digest | `c7af6302f9bf478785a96b5d70c7a215c212cb417b30448f2cc283ef833480c8` |
| Mock terminal | `success` |
| Quality gate | `true` |
| Integrity | `true` |

CLI와 범용 MCP 모두 명시적 GraphSpec의 validate/start/run을 제공합니다.

## 5. 실제 구현된 TUI

```bash
proofgraph tui
proofgraph tui <run_id>
proofgraph tui <run_id> --snapshot
```

화면:

```text
RUNS
GRAPH / AGENTS
INSPECTOR / APPROVALS
EVENTS
```

조작:

```text
Tab/arrow   focus
j/k         run 또는 node 선택
p           pause/resume + ready node 실행
s           node 하나 실행 후 pause
a,a         challenge-bound approve
d,d         challenge-bound deny
x,x         abort
r           refresh
?           safety help
q/Ctrl-C    quit
```

TUI는 state 파일을 직접 수정하지 않습니다. Pause/step은 `DebuggerController`, resume/approve/deny/abort는 `GraphKernel`을 통과합니다. 초기 verified model을 그린 뒤에만 키 입력을 받아 승인 경쟁 조건을 차단합니다.

## 6. 최종 검증

| 검증 | 결과 |
|---|---:|
| 전체 자동 시험 | **164/164 PASS** |
| 적대적 시험 | **41/41 PASS** |
| Evidence 독립 검증 | **18/18 PASS** |
| Graph 독립 검증 | **14/14 PASS** |
| Platform 독립 검증 | **10/10 PASS** |
| TUI 독립 검증 | **7/7 PASS** |
| 독립 검증 합계 | **49/49 PASS** |
| Preflight | **21 PASS / 0 FAIL / 1 SKIP** |
| Line coverage | **92.83%** |
| Branch coverage | **77.21%** |
| Function coverage | **91.88%** |

Preflight의 Skip은 검증 컨테이너에 Claude CLI가 없어 `claude plugin validate . --strict`를 실행하지 못한 항목입니다. 통과로 계산하지 않았습니다.

## 7. 구현 과정에서 발견·수정한 실제 결함

| 결함 | 재현된 문제 | 수정 |
|---|---|---|
| CLI 승인 출처 계약 | CLI 승인이 허용되지 않은 `decision_source`를 보내 승인 후 재개가 실패 | 런타임 계약의 `external_human`으로 통일하고 E2E 회귀 테스트 추가 |
| TUI 이중 키 race | 두 번째 승인 키가 첫 번째 확인 상태보다 먼저 처리될 수 있음 | 키 입력을 순서 보장 큐로 직렬화 |
| single-step 병렬 race | ready node가 여러 개면 step 1회에 여러 node가 debugger 경계에 진입 | `step` 모드의 커널 batch limit를 1로 강제 |

Coverage는 Node.js의 실험적 측정 기능을 사용합니다. 비동기·하위 프로세스 경로에서 반복 실행 간 소폭 변동이 관찰됐으며, 위 표는 최종 격리 실행값입니다. 관측 범위는 Line 92.52–92.86%, Branch 76.83–77.81%, Function 91.64–92.05%였습니다.

## 8. 정확한 해석

입증된 범위:

- 오탈자 포함 한국어 명령의 `agent-tui` 자동 선택
- bounded profile → GraphSpec v1 컴파일
- 명시적 GraphSpec의 CLI·MCP validate/start/run
- 승인 대기·이중 키 승인·resume·완료
- 연구 병렬화, 구현 단계, 기능·적대적 verifier, 실패 역라우팅
- 좁은/넓은 화면과 non-TTY snapshot
- 상태·event·report 변조 시 fail-closed
- 터미널 제어문자 제거와 종료 시 raw mode/cursor/alternate screen 복구

아직 입증하지 않은 범위:

- 실제 Claude/Codex/OpenCode/GJC/Grok/Pi가 이 그래프로 고품질 코드를 생성하는지
- 공급자별 인증·rate limit·비용·latency
- 원격 다중 사용자 운영
- 사람 신원의 암호학적 증명

따라서 현재 판정은 **오프라인 Graph Engineering/TUI 참조 구현 PASS, 실제 vendor canary REQUIRED**입니다.
