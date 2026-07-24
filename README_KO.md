# ProofGraph Claude MVP v0.2.0 — 설치 및 사용

## 1. 무엇을 구현했는가

ProofGraph Claude는 Claude Code 안에서만 사용하는 1차 MVP입니다. 하나의 플러그인에 다음을 묶었습니다.

```text
Claude Code Plugin
├─ /proofgraph-claude:research Skill
├─ planner / researcher / verifier / synthesizer Subagent
├─ read-only 정책 Hook
└─ local stdio MCP server
   ├─ 실행·예산 상태
   ├─ HTTPS 출처 수집과 SSRF 차단
   ├─ 정확 일치 인용 검증
   ├─ 주장·근거·판정 원장
   ├─ 결정론적 최종 분류
   └─ 해시 체인·무결성 검사
```

TUI나 별도 데몬은 만들지 않았습니다. 1차 MVP에서는 Claude Code 자체가 UI이고, MCP 서버가 통제·상태·증거 엔진 역할을 담당합니다.

## 2. 전제 조건

- Claude Code 최신 버전
- Node.js 20 이상
- Claude Code를 사용할 수 있는 로그인 또는 계정

이 플러그인의 MCP 서버는 Node.js 내장 모듈만 사용합니다. `npm install`은 필요하지 않습니다.

## 3. 가장 빠른 시험 실행

압축을 풀고 플러그인 루트에서 실행합니다.

```bash
node scripts/preflight.mjs
npm test
claude plugin validate . --strict
claude --plugin-dir .
```

Claude Code가 열리면 다음을 확인합니다.

```text
/plugin    → proofgraph-claude 구성요소가 보이는지 확인
/mcp       → proofgraph MCP 서버가 connected인지 확인
/hooks     → PreToolUse, PostToolUse, Stop Hook 확인
```

이후 다음처럼 실행합니다.

```text
/proofgraph-claude:research https://x.com/... 게시물의 기술적 주장을 공식 문서와 원문으로 검증해줘
```

또는 일반 주장도 가능합니다.

```text
/proofgraph-claude:research Claude Code 플러그인은 MCP 서버와 Hook을 함께 배포할 수 있다는 주장을 공식 문서로 검증해줘
```

## 4. 사용자 전체 설치

Claude Code의 skills-directory plugin 방식으로 설치할 수 있습니다.

### macOS·Linux·WSL

```bash
bash scripts/install-user.sh
```

기존 설치를 교체할 때:

```bash
bash scripts/install-user.sh --force
```

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-user.ps1
```

기존 설치를 교체할 때:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-user.ps1 -Force
```

설치 후 Claude Code를 다시 시작하거나 다음을 실행합니다.

```text
/reload-plugins
```

## 5. 실행 과정

```text
1. Skill이 pg_start_run 호출
2. planner가 고정 역할 계획과 원자적 주장 등록
3. 두 researcher가 병렬로 WebSearch 수행
4. 후보 URL은 pg_fetch_source가 직접 HTTPS로 재수집
5. 인용문은 저장 원문 속 정확 일치 여부를 서버가 검사
6. verifier가 별도 컨텍스트에서 판정 기록
7. 모든 작업 상태를 성공/실패/차단 중 하나로 종료
8. synthesizer가 pg_finalize_run 호출
9. 서버가 출처 수·정확 인용·검증 판정을 계산해 최종 분류
10. pg_verify_integrity가 이벤트·출처·보고서 해시 재검사
```

Claude의 자연어 출력이 최종 분류를 정하지 않습니다. 최종 `supported`, `refuted`, `mixed`, `unverified`는 MCP 서버가 저장 상태로부터 계산합니다.

## 6. 결과 해석

서버가 생성하는 보고서는 다음을 분리합니다.

- `supported`: 정책상 필요한 서로 다른 출처 호스트, 정확 인용, 독립 verifier 판정 충족
- `refuted`: 반박 근거와 verifier 판정 충족
- `mixed`: 지지와 반박 조건이 동시에 충족
- `unverified`: 증거 또는 검증 조건 부족

`quality_gate_passed: true`는 다음 조건을 뜻합니다.

```text
모든 계획 작업이 성공
+ failed/blocked/pending 없음
+ mixed/unverified 주장 없음
+ 로컬 무결성 조건 유지
```

이는 절대적 진리 인증이나 외부 공증을 뜻하지 않습니다. 정확 일치 인용은 저장 원문에 해당 문자열이 존재함을 확인할 뿐, 그 인용이 주장을 논리적으로 지지하는지 또는 문맥이 왜곡되지 않았는지는 별도의 의미 검토가 필요합니다.

## 7. 데이터 위치와 복구

실행 데이터는 플러그인 설치 코드가 아니라 `${CLAUDE_PLUGIN_DATA}` 아래에 저장됩니다.

```text
runs/<run_id>/
├─ state.json
├─ events.jsonl
├─ sources/*.txt
├─ report.json
└─ report.md
```

프로젝트별로 한 번에 하나의 활성 Run만 허용합니다. 중간에 멈췄다면 같은 프로젝트에서 Skill을 다시 호출해 활성 Run을 확인할 수 있습니다. 완료할 수 없을 때는 `pg_abort_run`으로 명시적으로 종료해야 합니다.

## 8. 기본 보안 정책

활성 Run 동안 Hook은 다음을 허용합니다.

- 번들 ProofGraph MCP 도구
- `WebSearch`
- 등록된 네 종류의 ProofGraph Subagent
- Agent 작업 조회·중단 도구
- 사용자 질문 도구

다음은 차단합니다.

- Bash·PowerShell
- Read·Write·Edit·NotebookEdit
- WebFetch
- 다른 MCP 서버
- 다른 Skill 또는 Agent
- 알 수 없는 도구

출처 수집 MCP는 다음도 차단합니다.

- HTTP
- 자격증명이 포함된 URL
- 443 이외 포트
- localhost·사설·예약·문서화 전용 IP
- 내부 도메인
- DNS 응답 중 하나라도 비공개 주소인 호스트
- 리디렉션 도중 비공개 주소로 바뀌는 요청
- 과도한 크기·시간·비허용 콘텐츠 유형

## 9. 예산

기본 정책은 다음과 같습니다.

```text
MCP·Agent·WebSearch로 계산되는 통제 작업: 80회
출처 fetch: 24회
주장: 12개
하위 Agent: 5개
벽시계: 30분
```

이 값은 MCP·도구 실행을 하드 차단합니다. Claude 모델 토큰이나 계정 청구액을 직접 제한하지는 않습니다. 계정 차원의 사용 한도는 별도로 설정해야 합니다.

## 10. 개발·검증 명령

```bash
npm run test:unit
npm run test:integration
npm run test:adversarial
npm test
npm run preflight
npm run verify:independent
npm run verify:package
```

현재 배포본 결과:

```text
단위 시험          26/26 PASS
통합 시험          13/13 PASS
적대적 시험        21/21 PASS
전체 자동 시험     60/60 PASS
독립 블랙박스      18/18 PASS
정적·MCP preflight 14개 PASS + Claude CLI strict validation 1개 SKIP
```

## 11. 운영 적용 판정

현재 권고는 다음과 같습니다.

```text
로컬 읽기 전용 Claude Code canary     GO
중요하지 않은 리서치 보조             조건부 GO
사람 검토 없이 외부 발표              NO-GO
법률·의료·재무·보안 최종 판단         NO-GO
광범위 조직 배포                       Claude 실기 canary 완료 전 NO-GO
```

실제 Claude Code 호스트에서 최소 20건의 canary를 수행하고, 허위 `supported` 0건·금지 도구 실행 0건·모든 Run의 명시적 finalize/abort를 확인한 뒤 범위를 넓히는 것이 적절합니다.
