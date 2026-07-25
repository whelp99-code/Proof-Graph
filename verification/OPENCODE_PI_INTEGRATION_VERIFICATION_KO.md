# ProofGraph v1.1.0 OpenCode·Pi 통합 검증 보고서

검증일: 2026-07-25
판정: **PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED**

## 1. 검증 대상

```text
OpenCode  1차 기준 Host
Pi        2차 Reference TUI Host
Orca      3차 호환 Host
```

검증 범위:

- `proofgraph.host.v1` Command/Event/Tool Policy 계약
- bearer-auth loopback HTTP/SSE Bridge
- OpenCode 프로젝트·사용자 Plugin 설치
- Pi 프로젝트·사용자 Extension 설치
- OpenCode Plugin custom tools·event·tool hook
- OpenCode Server Session·structured output·diff artifact
- Pi Extension command·tool·session persistence·approval projection
- Pi strict LF-delimited JSONL RPC Worker
- fail-closed permission/tool policy
- CLI와 독립 블랙박스 검증
- OpenCode config-root package manifest의 원자적 의존성 병합
- 검토 대상 Host 버전의 정확 일치 preflight

## 2. 결과

| 검증 | 결과 |
|---|---:|
| 전체 자동 시험 | **232/232 PASS** |
| 적대적 시험 | **60/60 PASS** |
| OpenCode·Pi Host 전용 시험 | **46/46 PASS** |
| 독립 블랙박스 전체 | **74/74 PASS** |
| 정적 Preflight | **27 PASS / 0 FAIL / 1 SKIP** |
| Host live preflight | **2 PASS / 0 FAIL / 4 SKIP** |
| TypeScript wrapper syntax | **PASS** |
| Line coverage | **92.11%** |
| Branch coverage | **74.82%** |
| Function coverage | **88.94%** |

독립 블랙박스 구성:

```text
Evidence Engine   18/18
Graph Engine      14/14
Platform          10/10
Local TUI          7/7
Orca              13/13
OpenCode·Pi       12/12
합계              74/74
```

## 3. 실제로 입증한 항목

### 공통 Host 계층

- protocol version이 다르거나 알 수 없는 key가 있는 요청 거부
- token 없는 Command/Event/Tool Policy 요청 거부
- loopback 기본 bind
- payload 상한
- expected revision 불일치 거부
- active Run 중 Bridge 장애 시 mutation fail-closed
- symlink root 및 부분 설치 거부
- 기존 파일 무단 덮어쓰기 방지
- OpenCode package manifest의 사용자 필드·기존 의존성 보존
- 의존성 충돌·manifest symlink·중간 실패의 transaction rollback
- 검토 대상과 다른 설치 버전의 preflight 거부

### OpenCode

- local Plugin 파일·Command 설치
- custom ProofGraph Tool 등록
- `tool.execute.before` 정책 질의
- session/file/diff 이벤트의 ProofGraph Event 변환
- fake authenticated OpenCode HTTP Server에서 Node별 Session 생성
- JSON Schema structured output 수신
- malformed AgentResult에서 Session abort
- Session diff를 Artifact로 보존
- mutation Host Tool은 isolated Workspace 없이는 거부
- OpenCode 모델 Tool에서 승인·거부·중단 권한 제거
- 별도 `--pure` Worker 서버 확인 전 실행 fail-closed
- Bridge 프로세스에 고정된 OpenCode Host identity와 요청 본문의 Host가 다르면 403 거부
- 유효한 Bridge token이 있어도 OpenCode 경로의 승인·거부·중단 명령은 403 거부

### Pi

- local Extension 설치
- `/pg`, 상태·재개·보고서·승인·중단 명령 등록
- active Run ID의 session entry 저장·복구
- `tool_call` 정책 질의와 Bridge 장애 fail-closed
- strict LF JSONL RPC 처리
- `agent_settled`만 최종 완료로 인정하고, `agent_end` 이후 조기 종료는 명시적 실패로 처리
- Unicode line separator가 있는 JSON string 보존
- blocking extension UI의 deny/cancel 처리
- malformed JSONL과 extension error의 명시적 실패
- mutation Tool은 isolated Workspace 없이는 거부

## 4. 적대적 검증

다음을 거부하거나 탐지했습니다.

```text
무인증 Bridge 요청
과대 payload
잘못된 protocol/event/command
외부 network bind 기본 사용
credential-bearing OpenCode URL
remote/insecure OpenCode endpoint
malformed AgentResult
malformed Pi JSONL
blocking Pi UI 요청
active Run에서 Bridge 장애
격리되지 않은 mutation
외부 부작용 및 destructive tool
symlink 설치 경로
설치 중간 실패의 부분 파일 잔류
revision race
Host identity 위조(OpenCode → Pi)
OpenCode Bridge token을 이용한 human-gate 명령 호출
```

## 5. 공식 계약 대조에서 발견·수정한 결함

초기 OpenCode Client는 global event stream을 `/event`로 요청했습니다. 최신 공식 Server 계약의 경로는 `/global/event`입니다. Mock 서버가 잘못된 경로를 그대로 모사하고 있어 기존 테스트가 이 결함을 놓쳤습니다.

수정 내용:

```text
OpenCodeClient.events() → GET /global/event
fake server·contract test도 공식 경로로 변경
/global/event가 아니면 회귀 테스트 실패
```

이 사례를 통해 Host mock은 구현을 복제하는 방식이 아니라 공식 endpoint·event 계약을 독립 fixture로 고정해야 한다는 검증 원칙을 추가했습니다.

추가 적대적 검토에서는 인증 token만 검증하고 요청 본문의 `host` 값을 신뢰하면 OpenCode 클라이언트가 Pi로 자신을 표기할 수 있고, generic command endpoint를 통해 사람 승인 권한에 접근할 수 있음을 확인했습니다. Bridge 인스턴스의 Host identity를 시작 시점에 고정하고, 불일치 요청과 OpenCode의 `approve`·`deny`·`abort`를 403으로 차단했습니다.

OpenCode 프로젝트 설치에서는 local Plugin이 import하는 `@opencode-ai/plugin` 의존성이 실제 config-root manifest에 없다는 결함도 발견했습니다. 설치기가 `.opencode/package.json`을 보존형으로 병합하고 `1.18.4`를 고정하도록 수정했으며, dependency conflict·symlink·부분 실패를 원자적으로 rollback하는 시험을 추가했습니다.

Host live preflight의 첫 구현은 정확 버전 비교 결과를 계산한 뒤 subprocess 성공값을 object spread로 다시 덮어써, 검토 대상과 다른 OpenCode 버전도 통과시킬 수 있었습니다. 필드 순서를 수정하고, 불일치 버전이 exit code 1과 명시적 실패 상태를 반환하는 회귀 시험을 추가했습니다.

또한 초기 계약 대상은 OpenCode 개발 브랜치 manifest의 `1.18.5`를 따랐지만, 실제 공개 설치 패키지는 `1.18.4`였습니다. 사용할 수 없는 선행 버전을 강제하지 않도록 CLI/server 계약 대상을 공개 안정판 `1.18.4`로 수정하고, `1.18.5`를 미검토 버전으로 거부하는 회귀 시험을 추가했습니다.

Pi RPC의 초기 구현은 `agent_end`를 짧은 grace 뒤 성공으로 승격할 수 있었습니다. 최신 Pi 계약에서는 `agent_end` 뒤 자동 재시도·압축·후속 작업이 이어질 수 있고 `agent_settled`가 실제 정착 완료 신호이므로, fallback을 제거하고 `agent_settled` 전용 완료·조기 종료 실패 회귀 시험을 추가했습니다.

## 6. 미검증 live 경계

이 환경에는 실제 `opencode` 및 `pi` 실행 파일과 인증된 모델 계정이 없었습니다. 따라서 다음을 성공으로 표시하지 않았습니다.

```text
실제 OpenCode Plugin 로딩
실제 OpenCode Server 인증·Session·Permission UI
실제 Pi Extension 로딩·/reload
실제 Pi RPC 모델 응답
실제 모델의 AgentResult 품질
실제 latency·token·비용
Host 버전별 API 호환성
```

Host live preflight의 네 Skip은 다음입니다.

```text
opencode CLI 미설치
pi CLI 미설치
Pi 미설치로 Node 22.19.0 gate 미실행
OPENCODE_SERVER_URL 미설정
```

## 7. 잔여 위험

1. Host Plugin/Extension은 해당 사용자 계정의 OS 권한으로 실행됩니다. ProofGraph 정책은 OS Sandbox가 아닙니다.
2. Git worktree는 network·kernel 격리를 제공하지 않습니다.
3. 한 Host 안의 `external_human` 승인자는 암호학적 사람 신원이 아니라 self-attested identity입니다.
4. OpenCode/Pi의 API와 event shape는 변경될 수 있으므로 version pin과 canary가 필요합니다.
5. `pure_worker_confirmed`는 운영자의 확인 기록이며 원격 서버의 실제 `--pure` 실행을 암호학적으로 증명하지 않습니다.
6. 실제 모델은 형식적으로 유효하지만 의미적으로 잘못된 AgentResult를 만들 수 있으므로 독립 검증 노드가 계속 필요합니다.

## 8. Production 승격 조건

- OpenCode·Pi 버전 pin
- 각각 대표 Graph 20건 이상 live canary
- tool-policy 우회 0건
- 승인 우회 0건
- malformed output silent promotion 0건
- timeout·abort·resume 100% 명시 상태
- OpenCode diff와 Pi session persistence 확인
- Host 재시작 후 Run 복구
- 비용·지연·오류율 기록

이 조건 전에는 `offline verified`로만 표시합니다.
