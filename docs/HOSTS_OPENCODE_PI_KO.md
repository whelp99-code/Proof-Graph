# OpenCode·Pi 우선 Host 통합

ProofGraph v1.1.0은 OpenCode를 1순위 Reference Host, Pi를 2순위 Reference Host로 둔다. 두 제품을 Fork하거나 내부 Runtime으로 흡수하지 않는다. ProofGraph가 GraphSpec, 실행 상태, 실패 역라우팅, 검증, 승인과 최종 상태의 권위자이며, OpenCode와 Pi는 사용자 인터페이스와 에이전트 실행 표면을 제공한다.

## 1. 공통 구조

```text
OpenCode TUI / Pi TUI
        │
        │ Plugin / Extension
        ▼
ProofGraph Host Bridge
  - Bearer 인증 REST 명령
  - SSE 이벤트
  - Tool Policy 판정
        │
        ▼
ProofGraph Graph Runtime
        │
        ├─ OpenCode Server Adapter
        └─ Pi strict JSONL RPC Adapter
```

Host UI 통합과 Worker 실행은 분리된다.

- Host UI 통합: 사용자가 OpenCode 또는 Pi 안에서 `/pg` 명령을 실행하고 상태·승인·보고서를 확인한다.
- Worker 실행: ProofGraph가 실제 Graph Node를 OpenCode HTTP 서버 또는 별도 Pi RPC 프로세스에 맡긴다.

이 분리는 Host가 바뀌어도 GraphSpec과 RunState가 유지되게 하며, 같은 Pi 프로세스가 자기 자신을 재귀 호출하거나 UI가 상태 파일을 직접 수정하는 것을 막는다.

## 2. 공통 Host Protocol

버전은 `proofgraph.host.v1`이다.

명령:

```text
compile / start / run / resume
status / report / integrity
approve / deny / abort
```

이벤트:

```text
host.connected / host.disconnected
session.created / session.status / session.idle / session.error
tool.requested / tool.completed / tool.failed
permission.requested / permission.resolved
artifact.created / ui.command
```

Tool Policy 결과:

```text
allow / deny / require_approval
```

Host는 명령을 요청할 뿐 Graph 상태를 직접 변경하지 않는다. 모든 변경은 GraphKernel을 통과한다.

Bridge는 시작할 때 지정된 Host identity를 강제한다. OpenCode Bridge의 generic command endpoint에서는 `approve`·`deny`·`abort`가 항상 거부되며, 해당 권한은 ProofGraph CLI/operator 경로에만 있다. Pi의 승인 명령은 대화형 UI 확인과 Runtime challenge 검사를 함께 거친다.

## 3. 설치

프로젝트 루트에서:

```bash
proofgraph host install opencode --scope project
proofgraph host install pi --scope project
```

OpenCode 설치 시 `.opencode/package.json`에 `@opencode-ai/plugin@1.18.4`를 병합한다. 기존 사용자 필드와 다른 의존성은 보존하고, 버전 충돌·심볼릭 링크·부분 설치는 fail-closed로 처리한다. 검토 계약 대상은 OpenCode 1.18.4, Pi 0.82.0이며 Pi Host는 Node.js 22.19.0 이상이 필요하다.

설치 경로:

```text
OpenCode
.opencode/plugins/proofgraph.ts
.opencode/proofgraph/core.mjs
.opencode/proofgraph/bridge-client.mjs
.opencode/commands/pg*.md

Pi
.pi/extensions/proofgraph/index.ts
.pi/extensions/proofgraph/core.mjs
.pi/extensions/proofgraph/bridge-client.mjs
```

사용자 전체 설치:

```bash
proofgraph host install opencode --scope user
proofgraph host install pi --scope user
```

대상은 각각 `~/.config/opencode/`와 `~/.pi/agent/`이다. 설치기는 경로 탈출과 심볼릭 링크를 거부하고, 모든 대상 파일을 사전 검사한 뒤 원자적으로 배치한다. 기존 파일은 `--force` 없이는 덮어쓰지 않는다.

## 4. Host Bridge 시작

강한 임의 토큰을 생성한다.

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8742"

proofgraph host serve opencode \
  --project "$PWD" \
  --port 8742 \
  --token "$PROOFGRAPH_HOST_TOKEN"
```

Bridge는 기본적으로 loopback에만 바인딩한다. 원격 바인딩은 기본 거부되며, Host 프로세스는 동일한 `PROOFGRAPH_HOST_URL`과 `PROOFGRAPH_HOST_TOKEN`을 상속해야 한다.

## 5. OpenCode 운영

### 5.1 OpenCode 서버

ProofGraph Worker Adapter는 OpenCode HTTP 서버를 사용한다. 기본 설정:

```json
{
  "adapters": {
    "opencode": {
      "enabled": true,
      "transport": "server",
      "server_url": "http://127.0.0.1:4096",
      "username": "opencode",
      "password_env": "OPENCODE_SERVER_PASSWORD",
      "allow_remote": false,
      "allow_insecure_remote": false,
      "max_response_bytes": 2000000,
      "allow_host_tools": false,
      "require_isolated_workspace": true,
      "keep_sessions": true,
      "pure_worker_confirmed": true
    }
  }
}
```

서버 시작 예:

```bash
export OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 32)"
# OpenCode UI Host와 분리된 Plugin-free Worker 서버
opencode --pure serve --hostname 127.0.0.1 --port 4096
```

v1.1에서는 OpenCode TUI Host와 Worker 서버를 같은 프로세스로 사용하지 않는다. TUI는 프로젝트 Plugin을 로드하고, Worker 서버는 별도 터미널에서 `--pure`로 실행하여 ProofGraph Plugin의 재귀 호출 가능성을 차단한다.

### 5.2 OpenCode Plugin

Plugin은 다음을 제공한다.

```text
/pg <목표>
/pg-status [run_id]
/pg-report [run_id]

proofgraph_compile
proofgraph_start
proofgraph_run
proofgraph_resume
proofgraph_status
proofgraph_report
proofgraph_integrity
```

`tool.execute.before`에서 활성 Run의 도구 호출을 Host Bridge에 보내며, Bridge가 `allow` 이외의 판정을 내리면 실행 전에 차단한다. Bridge에 접근할 수 없을 때도 활성 Run에서는 fail-closed로 차단한다.

### 5.3 OpenCode Worker 경계

- loopback 서버가 기본값이다.
- 원격 서버는 `allow_remote=true`, HTTPS, Basic Auth가 모두 필요하다.
- URL 안의 자격증명은 거부한다.
- JSON과 SSE 응답 크기를 제한한다.
- Structured Output Schema를 요청한다.
- malformed output이면 세션을 abort한다.
- UI Host와 Worker 서버는 분리하며, Worker는 `opencode --pure serve`로 시작한다.
- `pure_worker_confirmed=true`는 운영자가 이 전용 서버를 확인한 뒤에만 설정한다.
- Host mutation 도구는 기본 비활성이다.
- mutation 도구를 켜면 ProofGraph isolated workspace가 필수다.
- Session diff를 ProofGraph Artifact로 보존한다.

사람 승인·거부·중단은 OpenCode 모델 Tool이 아니라 ProofGraph CLI에서 수행한다.

```bash
proofgraph approve <run_id> <approval_id> <challenge> approve
proofgraph resume <run_id> --adapter opencode
proofgraph abort <run_id> "operator requested abort"
```

## 6. Pi 운영

Pi를 실행하면 `.pi/extensions/proofgraph/`가 자동 발견된다.

```bash
pi
```

주요 명령:

```text
/pg <목표>
/pg-status [run_id]
/pg-resume [run_id]
/pg-report [run_id]
/pg-integrity [run_id]
/pg-approve <approval_id> <challenge>
/pg-deny <approval_id> <challenge>
/pg-abort [사유]
```

Extension은 Run ID를 Pi session custom entry에 보존하고, 재시작 시 다시 연결한다. 승인·거부·중단은 Pi UI의 명시적 확인을 요구한다.

### 6.1 Pi Worker Adapter

기본 실행 계약:

```text
pi --mode rpc --no-session
--no-extensions
--no-skills
--no-prompt-templates
--no-context-files
--tools read,grep,find,ls
```

별도 Worker 프로세스에서는 Host Extension과 사용자 확장·Skill·Prompt Template·Context File 발견을 끈다. 이는 재귀 ProofGraph 호출과 예기치 않은 코드 실행을 줄인다.

기본 설정:

```json
{
  "adapters": {
    "pi": {
      "enabled": true,
      "command": "pi",
      "allow_host_tools": false,
      "safe_tools": ["read", "grep", "find", "ls"],
      "host_tools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
      "disable_discovery": true,
      "ui_policy": "deny",
    }
  }
}
```

- strict LF JSONL framing을 사용하며 Node `readline`에 의존하지 않는다.
- `agent_settled`만 최종 완료 신호로 사용한다. `agent_end`는 재시도·압축·후속 작업 전에 발생할 수 있으므로 성공으로 승격하지 않는다.
- 비대화형 Worker에서 `select`, `confirm`, `input`, `editor` 요청은 기본 거부한다.
- `ui_policy=cancel`일 때만 명시적 취소 응답을 보낸다.
- write/edit/bash를 활성화하면 isolated workspace가 필수다.
- 사용자 정의 `args`는 안전성을 추론할 수 없으므로 isolated workspace 없이는 거부한다.

## 7. 첫 실행

Host Bridge와 각 Host를 시작한 뒤:

OpenCode:

```text
/pg 인증 회귀 버그를 재현하고 수정안을 독립 검증하라
```

Pi:

```text
/pg 인증 회귀 버그를 재현하고 수정안을 독립 검증하라
```

터미널의 ProofGraph CLI에서도 같은 Run을 조회할 수 있다.

```bash
proofgraph status <run_id>
proofgraph report <run_id> json
proofgraph integrity <run_id>
```

## 8. 검증

```bash
npm run test:hosts
npm run verify:hosts
npm run hosts:preflight
```

`verify:hosts`는 production module을 직접 import하지 않고 CLI, HTTP, 가짜 OpenCode Server, 가짜 Pi JSONL RPC를 사용해 전체 Graph 완료를 확인한다.

`hosts:preflight`는 실제 `opencode`와 `pi` 설치 여부 및 선택적 OpenCode Server health를 확인한다. 실제 바이너리·로그인·모델·권한은 릴리스 환경 밖의 live canary가 필요하다.

## 9. 출시 경계

오프라인 통과는 다음을 의미한다.

```text
Host Protocol 동작
Plugin/Extension 설치 계약 동작
Bridge 인증·명령·이벤트·정책 동작
OpenCode HTTP 가짜 서버 E2E 동작
Pi strict JSONL 가짜 RPC E2E 동작
실패·크기·원격·UI 경계 차단
```

다음을 의미하지 않는다.

```text
실제 OpenCode 버전 호환 인증
실제 Pi 버전 호환 인증
실제 사용자 로그인과 모델 호출
실제 비용·지연·rate limit
실제 Host 권한 UI의 모든 조합
```

정식 운영 전 각 Host 버전을 고정하고 최소 20건의 live canary를 수행해야 한다.
