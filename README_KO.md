# ProofGraph v1.1.0 — 설치와 운영

**AI 코딩 도구를 위한 Graph Engineering Runtime**입니다.

ProofGraph는 개발 목표를 타입이 있는 상태 그래프로 컴파일하고, 역할별 에이전트·검증·실패 역라우팅·사람 승인·Workspace 변경을 결정론적으로 통제합니다. AI Council OS가 아니며, 새로운 모델을 만드는 프로젝트도 아닙니다. Claude Code, Codex, OpenCode, Gajae Code(GJC), Grok Build, Pi 및 사용자 정의 코딩 에이전트를 하나의 Graph Runtime에서 실행하기 위한 개발 도구입니다.

## v1.1.0 구성

```text
사용자 목표
  ↓
Dynamic Graph Compiler
  ↓
Typed Graph Runtime / State / Event Chain
  ↓
Adapter Router
  ├─ Claude
  ├─ Codex
  ├─ OpenCode — 1차 기준 Host
  ├─ GJC
  ├─ Grok
  ├─ Pi — 2차 Reference TUI Host
  ├─ Orca Execution Host
  └─ Custom
  ↓
Verifier / Failure Routing / Human Approval
  ↓
Approval-gated Git Worktree
  ↓
Inspector / Report / Integrity
```

완성된 기능:

- 자연어 → 검증된 GraphSpec
- 조건 분기, 제한된 반복, 동적 fan-out, checkpoint/resume
- 공통 AgentRequest/AgentResult 계약과 범용 Adapter 계층
- 승인된 변경만 적용하는 disposable Git worktree
- patch·명령 결과·diff·rollback receipt
- breakpoint, pause/resume, single-step, DOT, 로컬 Inspector
- OpenCode Plugin·Server/SSE·Permission Bridge를 결합한 1차 기준 Host
- Pi Extension·strict JSONL RPC·session persistence를 결합한 2차 Reference TUI Host
- `proofgraph.host.v1` 인증형 Host Protocol과 loopback HTTP/SSE Bridge
- OpenCode·Pi 프로젝트/사용자 범위 관리형 설치기
- Orca 외부 Operator UI·worktree·terminal 호환 브리지는 3순위 Host로 유지
- 선택형 dependency-free 로컬 TUI는 디버그·CI snapshot 용도로 유지
- 명시적 GraphSpec JSON의 validate/start/run
- agent-tui, feature, bugfix, refactor, security-audit, migration, research 템플릿
- CLI, ESM API, 범용 stdio MCP, Claude Code 플러그인
- 적대적·독립 블랙박스·패키지 검증

## 1. 설치

필수 조건:

```text
ProofGraph Core: Node.js 20 이상
Pi 0.82.0 Host 사용 시: Node.js 22.19.0 이상
Git
실제로 사용할 코딩 에이전트 CLI와 로그인
```

소스 설치:

```bash
git clone https://github.com/whelp99-code/Proof-Graph.git
cd Proof-Graph
npm ci --ignore-scripts
npm test
npm link
proofgraph version
```

전역 링크를 만들지 않으려면 모든 예제의 `proofgraph`를 다음으로 바꿉니다.

```bash
node /절대경로/Proof-Graph/bin/proofgraph.mjs
```

## 2. OpenCode·Pi 우선 Host 설치

Host 우선순위와 지원 기능을 확인합니다.

```bash
proofgraph hosts
proofgraph host paths
```

현재 프로젝트에 설치합니다.

```bash
proofgraph host install opencode --scope project
proofgraph host install pi --scope project
```

사용자 전체 설치는 `--scope user`를 사용합니다. OpenCode 설치기는 기존 `.opencode/package.json`을 삭제하지 않고 `@opencode-ai/plugin@1.18.4` 의존성만 병합합니다. 기존 의존성·script·사용자 필드는 보존하며, 다른 plugin 버전이 있으면 `--force` 없이는 중단합니다. Pi의 핵심 import는 Pi가 제공하므로 peer dependency로 유지합니다. 모든 설치 경로에서 심볼릭 링크와 부분 설치를 fail-closed로 거부합니다.

Host Bridge 시작:

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8743"
proofgraph host serve opencode --port 8743 --token "$PROOFGRAPH_HOST_TOKEN"
```

Pi는 별도 port/token으로 `proofgraph host serve pi`를 실행합니다. OpenCode Worker는 UI Host와 분리된 `opencode --pure serve` 인스턴스를 사용하고, 운영자가 이를 확인한 뒤에만 `pure_worker_confirmed=true`로 승격합니다. OpenCode 모델 도구에는 승인·거부·중단 권한을 노출하지 않으며, 해당 작업은 ProofGraph CLI에서 수행합니다. 오프라인 계약 대상은 OpenCode CLI/server 1.18.4, `@opencode-ai/plugin` 1.18.4, Pi 0.82.0입니다. 이는 live 인증이 아니며, 설치된 바이너리가 있으면 `npm run hosts:preflight`가 정확한 버전 일치를 검사합니다. 상세한 Worker 설정과 명령은 [OpenCode·Pi 통합 가이드](./docs/OPENCODE_PI_INTEGRATION_KO.md)를 참고하십시오.

## 3. 프로젝트 초기화

```bash
cd /개발/저장소
proofgraph init
```

생성 파일:

```text
proofgraph.config.json
.proofgraph/.gitignore
```

기존 설정은 `--force` 없이는 덮어쓰지 않습니다. 설정 파일이나 `.proofgraph`가 심볼릭 링크이면 초기화를 거부합니다.

## 4. 첫 실행

```bash
proofgraph templates
proofgraph compile "인증 회귀 버그를 수정하라" --template bugfix
proofgraph run "이 저장소의 결정론적 불변조건 하나를 설명하라"
```

초기 기본값은 `mock` Adapter입니다. 실제 외부 에이전트를 호출하지 않고 Graph Runtime을 검증합니다.

## 5. 템플릿

```text
agent-tui
feature
bugfix
refactor
security-audit
migration
research
```

예:

```bash
proofgraph run \
  "세션 토큰 회전 기능을 설계하고 구현안을 검증하라" \
  --template feature
```

프로젝트 전용 템플릿은 `proofgraph.config.json`의 `templates`에 같은 계약으로 추가할 수 있습니다.

## 6. AI Agent TUI

내장 TUI는 Reference Host가 아니라 디버그·CI snapshot용 보조 화면입니다. 자연어 목표를 전용 템플릿으로 컴파일할 수 있습니다.

```bash
proofgraph compile "AI 에이전트 TUI를 개발하라"
# --template 없이 agent-tui가 자동 선택됩니다.
```

검토 가능한 명시적 GraphSpec도 제공합니다.

```bash
proofgraph graph validate examples/graphs/ai-agent-tui.graph.json
proofgraph graph run examples/graphs/ai-agent-tui.graph.json --adapter mock
```

실행 중인 agent graph를 terminal에서 운영합니다.

```bash
proofgraph tui
proofgraph tui <run_id>
proofgraph tui <run_id> --snapshot
```

키는 `Tab/←/→`로 panel focus, `↑/k`·`↓/j`로 run 또는 node 선택, `p`로 pause/resume, `s`로 single-step, `a,a`로 승인, `d,d`로 거부, `x,x`로 중단, `r`로 refresh, `q`로 종료합니다. 승인·거부·중단은 4초 이내 동일 키 2회를 요구합니다. TUI는 state 파일을 직접 수정하지 않고 DebuggerController와 GraphKernel만 사용합니다. 상세 설계는 [AI Agent TUI 문서](./docs/AI_AGENT_TUI_KO.md), 그래프 형식은 [GraphSpec v1](./docs/GRAPH_SPEC_KO.md)을 참고하십시오.

## 7. 디버거 운영

Graph를 먼저 만들고 작업자 실행 전 멈출 수 있습니다.

```bash
proofgraph start \
  "결제 모듈의 오류 처리를 리팩터링하라" \
  --template refactor
```

반환된 `run_id`로:

```bash
proofgraph debug break <run_id> kind develop
proofgraph resume <run_id>
proofgraph debug status <run_id>
proofgraph inspect <run_id> text
proofgraph inspect <run_id> json
proofgraph inspect <run_id> dot
```

한 번만 breakpoint를 통과:

```bash
proofgraph debug bypass <run_id> <node_id>
proofgraph resume <run_id>
```

한 노드만 실행:

```bash
proofgraph debug step <run_id>
proofgraph resume <run_id>
```

웹 Inspector:

```bash
proofgraph serve <run_id>
```

기본적으로 `127.0.0.1`에만 바인딩되고 임의 bearer token을 요구합니다.

## 8. 실제 파일 변경

`proofgraph.config.json`:

```json
{
  "workspace": {
    "enabled": true,
    "require_approval": true,
    "require_clean": true
  }
}
```

운영 순서:

```bash
proofgraph workspace create <run_id>
proofgraph workspace propose <run_id> actions.json
proofgraph workspace approve <run_id> <challenge> approve
proofgraph workspace execute <run_id>
proofgraph workspace diff <run_id>
```

문제 시:

```bash
proofgraph workspace rollback <run_id>
```

`actions.json` 예:

```json
[
  {
    "type": "write_file",
    "path": "src/example.js",
    "content": "export const value = 1;\n"
  },
  {
    "type": "run_command",
    "argv": ["npm", "test"]
  }
]
```

제약:

- 절대 경로, `..`, `.git`, 심볼릭 링크 경로 차단
- shell 문자열이 아니라 argv 실행
- 명령 allowlist 적용
- 승인 action digest가 바뀌면 실행 거부
- 실패 시 rollback
- 직접 파일 변경을 감지하면 rollback

Git worktree는 파일 격리입니다. 네트워크·커널 격리는 컨테이너나 별도 sandbox가 필요합니다.

## 9. 실제 코딩 에이전트 연결

설정 예시는 [`examples/proofgraph.config.json`](./examples/proofgraph.config.json)을 참고합니다.

```bash
proofgraph adapters
```

각 Adapter는 기본적으로 비활성입니다. 설치·로그인 후 해당 설정의 `enabled`를 켜고 canary를 실행합니다.

```bash
npm run canary -- \
  --adapter claude \
  --project /개발/저장소
```

Codex, OpenCode, Grok, Pi도 같은 방식입니다. Claude는 print JSON, Codex는 `exec` JSON/JSONL, OpenCode의 기본 프로필은 authenticated Server API와 Structured Output이며 필요할 때 legacy subprocess를 선택할 수 있습니다. Grok은 headless JSON, Pi는 discovery를 끄고 read tool만 노출한 엄격한 LF JSONL RPC를 사용합니다. Codex의 JSON 출력 플래그는 릴리스 간 변화에 대응하도록 설정 가능합니다. Gajae Code v0.11은 외부 `--mode rpc`, `rpc-ui`, `bridge` CLI 진입점을 제거하고 SDK v3 WebSocket을 기계 제어 표면으로 지정했으므로, pinned SDK bridge 또는 신뢰할 수 있는 command profile 없이는 GJC를 fail-closed로 유지합니다.

### OpenCode·Pi First-class Host

OpenCode는 Plugin + Server API/SSE Worker, Pi는 Extension + strict JSONL RPC Worker로 연결됩니다.

```bash
cp examples/opencode-host.config.json proofgraph.config.json
# 또는
cp examples/pi-host.config.json proofgraph.config.json
```

예시 설정은 `enabled=false`, `default_adapter=mock`으로 제공됩니다. 실제 바이너리 설치·로그인·canary를 통과한 뒤에만 해당 Adapter를 활성화하십시오.

```bash
npm run test:hosts
npm run verify:hosts
npm run hosts:preflight
```

현재 Host 계층은 OpenCode/Pi Plugin·Extension, 인증 Bridge, 도구 정책, 설치, Mock E2E와 독립 블랙박스 검증을 완료했습니다. **OpenCode live canary 완료 (2026-07-25)**: bridge 서버 health·SSE·tool-policy·compile·보안 경계(approve/deny/abort 차단, host identity mismatch 403, 무단 접근 401)·plugin 모듈 로드(5 hooks) 모두 정상 동작 확인. Pi live canary는 미완료 (Pi 0.82.0 미설치).

### Orca Execution Host

Orca는 단일 모델 Adapter가 아니라 UI·worktree·terminal·agent process를 제공하는 **Execution Host**입니다. ProofGraph는 GraphSpec, ready node, 검증, 실패 역라우팅과 최종 상태의 권위자로 남습니다.

```bash
cp examples/orca-bridge.config.json proofgraph.config.json
# Orca UI에서 Agent Permissions를 Manual로 변경한 뒤
# adapters.orca.enabled=true
# adapters.orca.manual_permissions_confirmed=true
# `orca repo list --json`에서 repo ID를 확인하고
# adapters.orca.repo_selector="id:<repoId>"로 설정

orca status --json  # 실제 명령은 영문 ASCII `orca`
orca repo list --json
proofgraph adapters
proofgraph run "결정론적 불변조건 하나를 설명하라" --adapter orca
```

Orca-hosted run에서는 `workspace.enabled=false`와 명시적 `repo_selector`가 필수입니다. 활성 화면에 우연히 선택된 저장소가 아니라 지정한 저장소만 대상으로 삼습니다. Orca가 유일한 worktree 소유자이며 ProofGraph Workspace Engine을 동시에 켜면 실행을 거부합니다. bridge는 `task-create → worktree create → terminal wait → dispatch --inject → check`만 사용하고 Orca의 autonomous coordinator loop와 ad-hoc terminal injection은 사용하지 않습니다. 자세한 설정·canary·제한은 [Orca 통합 문서](./docs/ORCA_INTEGRATION_KO.md)를 참고하십시오.

## 10. 범용 MCP

```bash
proofgraph-mcp
```

또는:

```bash
proofgraph mcp
```

노출 기능:

```text
compile / start / run / resume
status / report / integrity / approval
adapters / templates
debug / inspect
workspace propose / decide / execute / diff / rollback
```

MCP 클라이언트 설정 예시는 [`examples/universal-mcp.json`](./examples/universal-mcp.json)에 있습니다.

## 11. Claude Code 플러그인

```bash
claude plugin validate . --strict
claude --plugin-dir .
```

Claude Code 내부:

```text
/proofgraph-claude:graph <개발 목표>
/proofgraph-claude:research <검증할 주장 또는 URL>
```

Claude 플러그인은 ProofGraph v1.0의 Adapter 중 하나입니다. 핵심 Runtime은 CLI와 범용 MCP에서도 독립적으로 동작합니다.

## 12. 검증

```bash
npm test
npm run preflight
npm run verify:independent
npm run verify:graph
npm run verify:platform
npm run verify:tui
npm run verify:orca
npm run verify:package
```

현재 릴리스 판정:

```text
전체 자동 시험              232/232 PASS
적대적 시험                   60/60 PASS
OpenCode·Pi Host 시험         46/46 PASS
독립 블랙박스                 74/74 PASS
정적 Preflight                27 PASS / 0 FAIL / 1 SKIP
Host live preflight            2 PASS / 0 FAIL / 4 SKIP
Coverage                       92.11% / 74.82% / 88.94%
오프라인 Runtime·Host 계약    PASS
실제 OpenCode live canary       DONE (2026-07-25)
실제 Pi live canary             REQUIRED
무인 프로덕션 mutation         NOT APPROVED
```

정적 Preflight의 1개 Skip은 검증 환경에 Claude CLI가 없어 `claude plugin validate . --strict`를 실행하지 못한 항목입니다. Host live preflight의 4개 Skip은 `opencode`·`pi` 바이너리 미설치, Pi 미설치로 인한 Node 22.19.0 gate 미실행, OpenCode Server URL 미설정입니다. 어느 항목도 통과로 계산하지 않았습니다.

출시 게이트는 `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`입니다. 실제 OpenCode·Pi 바이너리·로그인·모델 호출·permission UI·latency·비용을 이 환경에서 검증하지 않았으므로 production-ready로 표시하지 않습니다.

## 13. 추가 문서

- [OpenCode·Pi 우선 Host 통합](./docs/OPENCODE_PI_INTEGRATION_KO.md)
- [v1.1.0 통합 검증](./verification/OPENCODE_PI_INTEGRATION_VERIFICATION_KO.md)
- [v1.1.0 출시 판정](./verification/V1_1_0_RELEASE_DECISION_KO.md)

- [Orca 통합·운영](./docs/ORCA_INTEGRATION_KO.md)
- [Adapter 인증 매트릭스](./docs/ADAPTERS_KO.md)
- [아키텍처](./docs/ARCHITECTURE_KO.md)
- [GraphSpec v1 형식](./docs/GRAPH_SPEC_KO.md)
- [AI Agent TUI 참조 구현](./docs/AI_AGENT_TUI_KO.md)
- [운영 가이드](./docs/OPERATIONS_KO.md)
- [보안 모델](./docs/SECURITY_MODEL_KO.md)
- [알려진 제한](./docs/LIMITATIONS_KO.md)
- [v1.0.2 Orca 통합 검증](./verification/ORCA_INTEGRATION_VERIFICATION_KO.md)
- [v1.0.2 출시 판정](./verification/V1_0_2_RELEASE_DECISION_KO.md)
- [v1.0.1 AI Agent TUI 검증](./verification/V1_0_1_AGENT_TUI_VERIFICATION_KO.md)
- [v1.0.2 Orca 릴리스 노트](./docs/releases/v1.0.2.md)
- [v1.0.1 릴리스 노트](./docs/releases/v1.0.1.md)
- [v1.0.1 출시 판정](./verification/V1_0_1_RELEASE_DECISION_KO.md)
- [v1.0 최종 검증](./verification/V1_RELEASE_VERIFICATION_KO.md)
- [v1.0 출시 판정](./verification/V1_RELEASE_DECISION_KO.md)
- [전체 로드맵](./ROADMAP_KO.md)
