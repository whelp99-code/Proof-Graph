# ProofGraph v1.1 Adapter·Host 인증 매트릭스

ProofGraph는 모든 코딩 도구를 `AgentRequest`와 `AgentResult` 계약 뒤에 배치합니다. 프로필·플러그인·확장 코드가 존재한다는 사실만으로 운영 인증을 의미하지 않습니다. 외부 도구는 설치 버전 고정, 인증, 권한 경계, 구조화 출력, timeout·abort, 대표 canary를 통과해야 합니다.

v1.1부터 **사용자 인터페이스를 제공하는 Host**와 **Graph Node를 수행하는 Worker Adapter**를 분리합니다.

```text
OpenCode / Pi Host
= 사용자 명령, 상태, 승인, 세션 이벤트, 도구 정책 연결

OpenCode Server / Pi RPC Worker
= ProofGraph Graph Node의 실제 수행
```

## 인증 매트릭스

| 대상 | v1.1 연결 방식 | 안전 기본값 | 오프라인 검증 | 운영 게이트 |
|---|---|---|---|---|
| Mock | 프로세스 내부 결정론 Adapter | 활성 | 통과 | 개발·CI 전용 |
| OpenCode Host | 프로젝트/사용자 Plugin + 인증 Host Bridge | loopback, bearer token, active Run에서 fail-closed | 설치·Hook·정책·Mock E2E 통과 | 실제 TUI canary |
| OpenCode Worker | Server API + Global SSE + JSON Schema 출력 | 비활성, loopback, Basic Auth 권장, host tool 제한 | HTTP·SSE·structured output·diff·abort 계약 통과 | 버전 고정·인증·실모델 canary |
| Pi Host | TypeScript Extension + 인증 Host Bridge | active Run에서 tool call fail-closed | 설치·명령·세션 복구·승인·Mock E2E 통과 | 실제 TUI canary |
| Pi Worker | 엄격한 LF JSONL RPC subprocess | 비활성, discovery off, read-only tools, UI deny | framing·UI subprotocol·timeout·abort·출력 상한 통과 | 버전 고정·인증·실모델 canary |
| Claude Code | print-mode subprocess + JSON | 비활성, plan mode, write/shell 거부 | argv/parser 통과 | 로컬 인증 canary |
| Codex | `exec` subprocess + 설정형 JSON/JSONL flag | 비활성, read-only sandbox | argv/parser 통과 | 버전 고정 인증 canary |
| Grok | headless JSON subprocess | 비활성, 격리 Workspace 필수 | argv/parser 통과 | 인증 canary + 권한 검토 |
| Gajae Code | SDK v3 WebSocket bridge 또는 명시적 command profile | 비활성/fail-closed | 설정 경계 통과 | pinned bridge + 인증 canary |
| Orca | tracked Task/Dispatch + worktree/terminal Execution Host | 비활성, Manual 권한, mutation 금지 | 계약·적대적·블랙박스 통과 | pinned macOS Orca canary |
| Custom | 운영자가 제공하는 `AgentAdapter`/`ExecutionHost` | 미등록 | 계약 시험 제공 | 운영자 책임 인증 |

## OpenCode Host

관리형 설치 위치:

```text
프로젝트: .opencode/plugins/proofgraph.ts
사용자:   ~/.config/opencode/plugins/proofgraph.ts
```

Plugin은 ProofGraph 명령과 Custom Tool을 등록하고, `tool.execute.before`에서 활성 Run의 도구 요청을 Host Bridge 정책으로 검사합니다. `permission.asked`, `session.status`, `session.diff`, `session.error` 등 Host 이벤트를 ProofGraph 이벤트로 전달합니다.

OpenCode 자체의 `permission` 설정도 함께 사용해야 합니다. ProofGraph Plugin은 추가적인 제어 경계이며, OpenCode의 기본 권한 설정을 대체하지 않습니다. 특히 edit·bash·외부 도구는 `deny` 또는 `ask`로 제한하고, ProofGraph의 승인·Workspace 정책을 우회하는 `--auto` 운영은 live canary 전 금지합니다.

## OpenCode Worker

v1.1의 기준 Worker는 `opencode run` subprocess가 아니라 OpenCode Server API입니다.

```text
Ready Node
→ Server Session 생성
→ 역할을 plan/build Agent에 매핑
→ JSON Schema AgentResult 요청
→ structured_output 검증
→ session diff를 Artifact로 저장
→ 실패·malformed output이면 session abort
```

Global event stream은 `/global/event`, health는 `/global/health`를 사용합니다. loopback이 아닌 서버는 기본 거부하며, 명시적으로 허용하더라도 HTTPS와 Basic Auth를 요구합니다. Developer가 Host tool을 사용할 때는 ProofGraph 격리 Workspace가 필수입니다.

OpenCode v1.1.1 이후 권한의 기준은 `permission`이며, 과거 `tools` boolean은 하위 호환용입니다. v1.1 구현은 Plugin의 `tool.execute.before`를 주 경계로 사용하고, Server message의 legacy tool disable 필드는 하위 호환 방어로만 유지합니다.

## Pi Host

관리형 설치 위치:

```text
프로젝트: .pi/extensions/proofgraph/index.ts
사용자:   ~/.pi/agent/extensions/proofgraph/index.ts
```

Extension은 `/pg`, `/pg-status`, `/pg-resume`, `/pg-integrity`, `/pg-report`, `/pg-approve`, `/pg-deny`, `/pg-abort` 명령을 제공합니다. 활성 Run ID는 Pi session entry에 저장하고 세션 재개 시 복원합니다. `tool_call`에서 Host Bridge 정책이 `allow`가 아니거나 Bridge에 연결할 수 없으면 도구를 차단합니다.

Pi Extension은 사용자 프로세스 권한으로 실행되므로 운영체제 수준의 Sandbox가 아닙니다. 파일 mutation·shell·network는 ProofGraph Workspace 정책과 별도 Container/VM 경계가 필요합니다.

## Pi Worker

전용 RPC client는 다음 안전 인자를 기본 사용합니다.

```text
pi --mode rpc --no-session
  --no-extensions
  --no-skills
  --no-prompt-templates
  --no-context-files
  --tools read,grep,find,ls
```

RPC는 LF(`\n`)만 record delimiter로 사용하는 엄격한 JSONL입니다. Unicode line separator를 줄 경계로 취급하지 않으며, malformed JSON·output cap·timeout·abort를 명시적 실패로 보존합니다. 대화형 `extension_ui_request`는 기본 `deny`; 선택적으로 명시적 cancellation response를 보낼 수 있습니다. Mutation 도구는 격리 Workspace 없이는 제공하지 않습니다.

## 기존 Adapter

### Claude Code

비대화형 print mode, JSON 출력, plan permission mode, 최대 turn, Write/Edit/Bash 거부 목록을 사용합니다. 설치 버전별 envelope과 권한 동작은 달라질 수 있으므로 live canary가 필수입니다.

### Codex

`codex exec`, read-only sandbox와 설정 가능한 `output_args`를 사용합니다. 여러 event envelope을 parser가 수용하지만 live canary를 대체하지는 않습니다.

### Grok

`--no-auto-update`, JSON 출력, `--cwd`, `-p`를 사용하는 headless 프로필입니다. Host tool mutation 가능성이 있으므로 격리 Workspace를 요구합니다.

### Gajae Code

외부 RPC CLI 표면을 추측하지 않습니다. pinned SDK WebSocket bridge 또는 `{prompt}`, `{cwd}` placeholder를 가진 명시적 command profile이 있을 때만 활성화합니다.

### Orca

Orca는 `ExecutionHost` 경계를 사용합니다. ProofGraph Node를 Orca Task·worktree·terminal·Dispatch에 매핑하지만 Graph route와 terminal state의 권위자는 ProofGraph입니다. Orca Agent Permissions를 Manual로 설정하고 `workspace.enabled=false`로 두어 이중 Workspace 소유를 방지합니다.

## 인증 실행

```bash
proofgraph adapters
proofgraph doctor
npm run test:hosts
npm run verify:hosts
npm run hosts:preflight
npm run canary -- --adapter <name> --project /개발/저장소
```

다음을 모두 기록해야 운영 인증으로 승격할 수 있습니다.

```text
Host/CLI 정확한 버전
인증 방식
대표 Graph 성공·실패 사례
금지 mutation·승인 우회 0건
timeout·abort·resume 결과
구조화 출력 오류율
비용과 p50/p95 지연
```

현재 v1.1.0 게이트는 `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`입니다.
