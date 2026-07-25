# ProofGraph v1.0.2 아키텍처

```text
CLI / ESM API / Universal MCP / Claude Plugin
                    │
             Platform Factory
                    │
  ┌─────────────────┼──────────────────┐
  ▼                 ▼                  ▼
Graph Compiler   Adapter Router   Template Registry
  │                 │
  ▼                 ▼
Graph Runtime   Coding Agent Drivers
  │
  ├─ State + Event Hash Chain
  ├─ Conditional Edge / Bounded Loop
  ├─ Failure Routing / Human Approval
  ├─ Workspace Engine
  └─ Debugger + Inspector
```

제어면은 일반 코드가 담당합니다. Graph 검증, edge 선택, 예산, 승인, event commit, workspace action digest, 무결성은 LLM의 자연어 판단으로 변경할 수 없습니다. 에이전트는 구조화된 AgentResult를 제출하는 작업자입니다.

Claude Code 플러그인은 v1.0 Runtime의 Host Adapter입니다. CLI·ESM·범용 MCP가 기본 제품 표면이고, 다른 코딩 도구는 Adapter 계약을 통해 연결합니다.

Workspace Engine은 disposable Git worktree를 만들고, 에이전트가 제안한 typed action을 승인 후 적용합니다. worktree는 파일 격리일 뿐 네트워크·커널 격리는 아닙니다.

## Adapter 경계

공통 AgentRequest는 Host별 CLI·RPC·SDK bridge 호출로 변환되고 결과는 AgentResult로 정규화됩니다. Claude print JSON, Codex exec JSON/JSONL, OpenCode run JSON events, Grok headless JSON, Pi strict JSONL RPC 프로필을 제공합니다. Codex는 버전별 출력 플래그 차이 때문에 `output_args`를 설정할 수 있습니다. Gajae Code v0.11은 외부 `--mode rpc`, `rpc-ui`, `bridge` CLI 진입점을 제거하고 SDK v3 WebSocket을 기계 제어 표면으로 지정하므로, pinned bridge 또는 명시적 command profile과 live canary 없이는 실행하지 않습니다.

## AI Agent TUI

`runtime/tui/app.mjs`는 검증된 run state를 읽는 로컬 운영자 클라이언트입니다. 조회는 integrity 검사를 통과한 state/event/report만 사용하고, pause·resume·single-step은 `DebuggerController`와 `GraphKernel`을 통해 실행합니다. 승인·거부·중단은 challenge 및 이중 키 확인을 거쳐 GraphKernel에 위임합니다. 따라서 TUI가 state 파일을 직접 쓰거나 별도의 Control Plane을 만들지 않습니다. interactive alternate-screen 모드와 결정론적 non-TTY snapshot 모드를 모두 지원합니다.


## Orca Execution Host

```text
ProofGraph Kernel
  └─ OrcaExecutionHost
      ├─ orchestration task-create
      ├─ worktree create
      ├─ terminal list/wait
      ├─ orchestration dispatch --inject
      ├─ orchestration check
      └─ exact AgentResult report validation
```

Orca는 화면·terminal·agent process·worktree의 실행 권위자이고, ProofGraph는 GraphSpec·ready node·검증·실패 route·terminal status의 상태 권위자입니다. `orca orchestration run`은 사용하지 않습니다. 두 오케스트레이터가 동시에 다음 경로를 선택하지 않도록 수동 추적형 primitive만 사용합니다.
