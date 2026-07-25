# ProofGraph v1.1 — OpenCode·Pi 우선 Host 통합

## 1. 제품 결정

ProofGraph의 UI 우선순위는 다음으로 고정합니다.

1. **OpenCode** — 1차 기준 Host 및 기본 프로덕션 통합 대상
2. **Pi** — 2차 Reference TUI Host 및 빠른 확장 실험 대상
3. Orca — 기존 호환 Host로 유지
4. 내장 `proofgraph tui` — 디버그·CI snapshot·비상 복구용으로만 유지

ProofGraph는 OpenCode 또는 Pi의 내부 오케스트레이터가 되지 않습니다. GraphSpec, ready-node 계산, 실패 역라우팅, 검증, 승인 정책, Workspace 변경 및 terminal 상태의 최종 권위자는 계속 ProofGraph입니다.

```text
OpenCode TUI / Pi TUI
        │
        │ Host Plugin / Extension
        ▼
Authenticated ProofGraph Host Bridge
        │
        ▼
ProofGraph Compiler / Runtime / Policy
        │
        ├─ OpenCode Server Worker
        ├─ Pi JSONL RPC Worker
        └─ 다른 Adapter
```

## 2. 두 개의 실행 평면

### Host/UI plane

사용자가 보는 OpenCode 또는 Pi 세션입니다.

- 그래프 시작·재개·상태·보고서·무결성 조회
- 승인 또는 거부
- 도구 실행 전 ProofGraph 정책 질의
- 세션·도구·artifact 이벤트 전달
- 현재 Run을 Host 세션에 연결

### Worker execution plane

ProofGraph Graph Node를 실제로 수행합니다.

- OpenCode: OpenCode Server API에서 Node별 Session 생성
- Pi: `pi --mode rpc --no-session` JSONL Worker 실행
- AgentResult 계약으로 결과 정규화
- Worker 실패·timeout·malformed output을 Failure Packet으로 보존

Host와 Worker는 같은 제품을 사용할 수 있지만 동일 프로세스일 필요는 없습니다. 예를 들어 Pi TUI는 운영 화면이고, Graph Node는 별도 Pi RPC subprocess에서 수행됩니다.

## 3. 공통 Host Protocol

프로토콜 버전:

```text
proofgraph.host.v1
```

Transport:

```text
명령       HTTP POST /v1/commands
도구 정책  HTTP POST /v1/tool-policy
이벤트     HTTP POST /v1/events
실시간     HTTP GET  /v1/events  (SSE)
상태 확인  HTTP GET  /v1/health
기능 협상  HTTP GET  /v1/capabilities
```

기본 보안 경계:

- `127.0.0.1` loopback bind
- Bearer token 필수
- 고정된 protocol version
- 요청 body 상한
- 알 수 없는 key·event·command 거부
- `expected_revision` 기반 낙관적 동시성 제어
- 활성 Run에서 정책 Bridge 장애 시 fail-closed
- mutation·외부 부작용은 격리 Workspace와 승인 없이는 거부

## 4. 설치

ProofGraph를 먼저 설치합니다.

```bash
npm ci --ignore-scripts
npm link
proofgraph version
```

### OpenCode 프로젝트 설치

```bash
cd /path/to/project
proofgraph host install opencode --scope project
```

설치 파일:

```text
.opencode/package.json  # 기존 manifest에 고정 의존성 병합
.opencode/plugins/proofgraph.ts
.opencode/proofgraph/core.mjs
.opencode/proofgraph/bridge-client.mjs
.opencode/commands/pg.md
.opencode/commands/pg-status.md
.opencode/commands/pg-report.md
```

사용자 전역 설치:

```bash
proofgraph host install opencode --scope user
```

전역 root는 기본적으로 `~/.config/opencode`입니다.

### Pi 프로젝트 설치

```bash
cd /path/to/project
proofgraph host install pi --scope project
```

설치 파일:

```text
.pi/extensions/proofgraph/index.ts
.pi/extensions/proofgraph/core.mjs
.pi/extensions/proofgraph/bridge-client.mjs
```

사용자 전역 설치:

```bash
proofgraph host install pi --scope user
```

전역 root는 기본적으로 `~/.pi/agent`입니다.

OpenCode 설치기는 기존 config-root `package.json`을 삭제하지 않고 `@opencode-ai/plugin@1.18.4`를 `dependencies`에 병합합니다. 다른 의존성·script·사용자 필드는 보존하며, 이미 다른 plugin 버전이 있으면 `--force` 없이는 중단합니다. 모든 대상은 먼저 검사한 뒤 staging·backup·rollback 순서로 반영하므로 중간 실패 시 기존 파일을 복구합니다. 설정 root, package manifest 또는 대상 경로가 심볼릭 링크이면 중단합니다.

독립 배포용 Host 패키지는 다음 명령으로 재현 가능하게 생성합니다.

```bash
npm run package:hosts
```

생성물:

```text
dist/hosts/proofgraph-host-opencode-1.1.0.tgz
dist/hosts/proofgraph-host-pi-1.1.0.tgz
```

패키징 스크립트는 Host 패키지 이름·버전·파일 목록을 고정 검사하고, 이전 `dist/hosts` 내용을 제거한 뒤 새 tarball만 생성합니다.

### 검토된 Host 계약 버전

```text
OpenCode CLI/server       1.18.4
@opencode-ai/plugin       1.18.4
Pi CLI                    0.82.0
Pi 실행 Node.js           22.19.0 이상
```

위 값은 v1.1.0이 소스·프로토콜 계약을 검토한 대상이며 live 인증 결과가 아닙니다. 실제 바이너리가 설치된 환경에서 `npm run hosts:preflight`는 버전을 파싱해 정확한 계약 대상과 비교합니다. 그 뒤 인증된 representative canary를 별도로 통과해야 합니다. Pi의 `@earendil-works/pi-coding-agent`와 `typebox`는 Pi가 Extension에 제공하는 core import이므로 공식 권고대로 peer dependency `*`를 유지합니다.

## 5. Host Bridge 시작

32바이트 이상의 임의 token을 준비합니다.

```bash
export PROOFGRAPH_HOST_TOKEN="$(openssl rand -hex 32)"
proofgraph host serve opencode \
  --port 8743 \
  --token "$PROOFGRAPH_HOST_TOKEN"
```

다른 터미널에서 Host를 실행하기 전에 환경 변수를 전달합니다.

```bash
export PROOFGRAPH_HOST_URL="http://127.0.0.1:8743"
export PROOFGRAPH_HOST_TOKEN="...같은 token..."
```

Pi Host로 실행할 때:

```bash
proofgraph host serve pi --port 8744 --token "$PROOFGRAPH_HOST_TOKEN"
```

하나의 Bridge 프로세스는 하나의 Host identity로 실행합니다. 프로젝트별로 token과 port를 분리하는 것을 권장합니다.

요청 본문의 `host`는 Bridge 시작 시 고정된 identity와 반드시 일치해야 하며, 다른 Host로의 자기표시는 403으로 거부됩니다. OpenCode Bridge는 유효한 token을 가진 경우에도 `approve`·`deny`·`abort`를 실행하지 않습니다. OpenCode의 사람 승인·중단은 ProofGraph CLI의 operator 경로에서 수행해야 합니다.

## 6. OpenCode Worker 설정

안전한 초기 예시는 [`examples/opencode-host.config.json`](../examples/opencode-host.config.json)에 있으며, 해당 파일은 `enabled=false`, `pure_worker_confirmed=false`로 시작합니다. 아래는 전용 `--pure` Worker 서버를 운영자가 확인한 뒤의 활성 설정입니다.

핵심 설정:

```json
{
  "default_adapter": "opencode",
  "adapters": {
    "opencode": {
      "enabled": true,
      "transport": "server",
      "server_url": "http://127.0.0.1:4096",
      "password_env": "OPENCODE_SERVER_PASSWORD",
      "allow_remote": false,
      "allow_host_tools": false,
      "require_isolated_workspace": true,
      "pure_worker_confirmed": true
    }
  }
}
```

운영 전 확인:

```bash
export OPENCODE_SERVER_PASSWORD="..."
# UI Host와 분리된 Worker 전용 서버. --pure는 외부 Plugin을 로드하지 않습니다.
opencode --pure serve --hostname 127.0.0.1 --port 4096

# 위 전용 서버를 직접 확인한 뒤에만 proofgraph.config.json에서
# pure_worker_confirmed를 true로 변경합니다.
proofgraph adapters
proofgraph doctor
npm run hosts:preflight
```

OpenCode Node 실행 흐름:

```text
Ready Node
→ OpenCode Server Session 생성
→ role을 plan/build Agent에 매핑
→ JSON Schema AgentResult 요청
→ session diff를 Artifact로 저장
→ malformed output이면 Session abort + Node failure
```

`allow_host_tools=true`인 Developer Node는 ProofGraph가 생성한 격리 Workspace가 없으면 실행되지 않습니다.

## 7. Pi Worker 설정

안전한 예시는 [`examples/pi-host.config.json`](../examples/pi-host.config.json)에 있습니다.

핵심 설정:

```json
{
  "default_adapter": "pi",
  "adapters": {
    "pi": {
      "enabled": true,
      "command": "pi",
      "allow_host_tools": false,
      "disable_discovery": true,
      "ui_policy": "deny"
    }
  }
}
```

ProofGraph는 기본적으로 다음 방식으로 Pi Worker를 실행합니다.

```text
pi --mode rpc --no-session
  --no-extensions
  --no-skills
  --no-prompt-templates
  --no-context-files
  --tools <read-only tools>
```

RPC는 LF 구분 JSONL로 처리하고, malformed JSONL·대화형 UI 요청·출력 상한 초과·timeout을 명시적 실패로 보존합니다. Mutation 도구는 격리 Workspace 없이는 허용하지 않습니다.

## 8. 사용자 명령

### OpenCode

설치 후 OpenCode에서 다음 명령을 사용할 수 있습니다.

```text
/pg <개발 목표>
/pg-status
/pg-report
```

또한 모델이 호출할 수 있는 다음 ProofGraph Tool이 등록됩니다. 사람 승인과 Run 중단은 모델 Tool로 노출하지 않습니다.

```text
proofgraph_compile
proofgraph_start
proofgraph_run
proofgraph_resume
proofgraph_status
proofgraph_report
proofgraph_integrity
```

OpenCode의 사람 승인·거부·중단은 별도 터미널에서 실행합니다.

```bash
proofgraph status <run_id>
proofgraph approve <run_id> <approval_id> <challenge> approve
proofgraph resume <run_id> --adapter opencode
# 중단할 때
proofgraph abort <run_id> "operator requested abort"
```

### Pi

```text
/pg <개발 목표>
/pg-status
/pg-resume
/pg-integrity
/pg-report
/pg-approve <approval_id> <challenge>
/pg-deny <approval_id> <challenge>
/pg-abort [reason]
```

Pi 세션에는 active Run ID가 custom session entry로 저장되며, 세션을 다시 열면 상태를 재연결합니다.

## 9. 승인과 도구 정책

OpenCode의 `tool.execute.before`와 Pi의 `tool_call`은 활성 Run에서 ProofGraph 정책 Bridge를 통과합니다.

```text
read-only + 정책 허용
→ allow

mutation + 승인된 격리 Workspace
→ allow 또는 require_approval

외부 부작용·destructive action
→ deny 또는 require_approval

Bridge 장애
→ deny (fail-closed)
```

Host UI에서 승인 버튼이나 명령을 눌렀다는 사실만으로는 충분하지 않습니다. `approval_id`, challenge, Run ID 및 `external_human` decision source가 Runtime 상태와 일치해야 합니다.

## 10. 검증 명령

```bash
npm run test:hosts
npm run verify:hosts
npm run hosts:preflight
npm run release:verify
```

현재 오프라인 검증 범위:

- Host Protocol·Bridge·Installer·CLI 계약
- OpenCode Plugin/Pi Extension mock E2E
- OpenCode Server Client/Session/Diff 계약
- Pi strict JSONL RPC parser와 UI fail-closed
- 인증·payload·symlink·revision·mutation 적대적 시험
- production module import가 없는 독립 블랙박스 검증

실제 OpenCode·Pi 바이너리와 인증 세션이 없는 환경에서는 live canary를 통과로 표시하지 않습니다.

## 11. 출시 게이트

현재 상태:

```text
PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED
```

production-ready 승격 전 필수:

1. OpenCode와 Pi 버전 고정
2. 실제 로그인/인증
3. 대표 Graph 20건 이상 실행
4. tool policy 우회 0건
5. malformed output silent promotion 0건
6. 승인 우회 0건
7. timeout·abort·재개 정상 동작
8. OpenCode diff와 Pi session persistence 확인
9. Host 종료 후 ProofGraph Run 복구
10. 결과와 비용·지연 기록
