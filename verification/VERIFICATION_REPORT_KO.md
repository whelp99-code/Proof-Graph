# ProofGraph Claude MVP v0.2.0 독립 검증 보고서

검증일: 2026-07-24 KST  
대상: Claude Code 전용 플러그인 + 내장 stdio MCP + 결정론적 Hook  
환경: Linux x86_64, Node.js v22.16.0

## 1. 종합 판정

```text
오프라인 코드·프로토콜 MVP       PASS
블랙박스 MCP·Hook 독립검증        PASS
적대적 검증                       PASS WITH ONE DOCUMENTED RESIDUAL
실제 Claude Code host canary       NOT RUN
조직 전체 운영 배포               NO-GO UNTIL CANARY
로컬 읽기 전용 canary             GO
```

현재 검증 환경에는 `claude` 실행 파일과 인증 세션이 없었다. 따라서 `claude plugin validate`, 실제 플러그인 로딩, 실제 WebSearch, 실제 Subagent lifecycle은 실행하지 못했다. 이 한계를 결과에서 제외하거나 통과로 간주하지 않았다.

## 2. 자동 시험

| 구분 | 결과 |
|---|---:|
| 단위 시험 | 26/26 PASS |
| 통합 시험 | 13/13 PASS |
| 적대적 시험 | 21/21 PASS |
| 전체 | 60/60 PASS |
| Node 내장 coverage | line 89.51%, branch 77.03%, functions 92.63% |
| 실패·취소·skip | 0 |

원시 로그:

- `unit_tests.txt`
- `integration_tests.txt`
- `adversarial_tests.txt`
- `full_tests.txt`

## 3. 독립 블랙박스 검증

`verification/independent_verifier.mjs`는 ProofGraph production module을 import하지 않는다. 다음 인터페이스만 사용한다.

- newline-delimited JSON-RPC stdio
- MCP initialize / tools/list / tools/call
- Hook subprocess stdin/stdout
- 최종 저장 파일과 의도적 변조

결과:

```text
18/18 검사 실행
실패 0
보호 기능 PASS 17
잔여 위험 특성화 1
Release gate: PASS_OFFLINE_CANARY_REQUIRED
```

검사 범위:

1. 플러그인 manifest·component 경로 일치
2. 초기화 이전 MCP 접근 차단
3. protocol negotiation
4. 운영 tool surface 14개와 test tool 비노출
5. malformed JSON·unknown tool 처리 후 생존
6. 전체 증거 lifecycle과 supported 결정론 판정
7. MCP 재시작 후 상태 유지
8. 조작 인용·임의 source ID 거부
9. 동일 hostname 출처의 독립성 위장 차단
10. prompt injection 표시 출처 자동 승격 제외
11. 역할 간 상태 변경 위장 차단
12. hard tool-call budget 상태 전이
13. 프로젝트별 단일 활성 Run
14. Shell·Skill·외부 MCP 우회 차단
15. state 삭제·손상 시 Hook fail-closed
16. 문법상 유효한 상태 변조로 active Run을 terminal로 위장하는 우회 차단
17. 미완료 Stop 차단
18. source·report·event 변조 탐지

## 4. Preflight

정적·프로토콜 preflight는 다음을 검사한다.

- Node 버전
- package·plugin 버전 일치
- component 파일 존재
- Hook·MCP 구성
- 모든 `.mjs` 구문
- 외부 runtime import 부재
- MCP 초기화·tool schema·운영 surface
- 활성 Run이 없을 때 Hook 무간섭
- Claude CLI가 있으면 strict plugin validation

결과:

```text
14개 실행 검사 PASS
Claude CLI strict validation SKIP — CLI 없음
실패 0
```

## 5. 검증 중 발견하여 수정한 결함

### IPv4·IPv6 차단 목록 혼용

하나의 `net.BlockList`에 IPv4-mapped IPv6 대역을 섞으면서 공개 IPv4까지 차단되는 오류가 드러났다. 주소군별 BlockList로 분리했고 전체 시험을 재실행했다.

### active state 손상 시 fail-open 가능성

active pointer는 남아 있는데 `state.json`이 삭제·손상되면 Hook이 실행 중 Run이 없는 것으로 오인할 수 있었다. 상태 오류를 숨기지 않고 모든 도구 요청을 차단하도록 변경했다.

### 간접 실행 우회

활성 Run 동안 다른 Skill, Monitor, ToolSearch, 외부 MCP가 간접적으로 위험 도구를 호출할 수 있는 경로를 닫았다. 허용 목록을 번들 MCP, 지정 Agent, WebSearch와 최소 작업 관리 도구로 축소했다.

### MCP output schema 불일치

도구가 다양한 구조화 필드를 반환하지만 output schema가 `ok`만 허용하던 모순을 수정해 추가 문서화 필드를 허용했다.

### 상태 JSON 단독 변조

이벤트 체인만 검증하면 공격자가 `state.json`을 바꾸고 event head를 그대로 둘 수 있었다. 모든 transaction에 상태 digest를 포함한 `state.committed` 이벤트를 추가하고 다음 mutation 전에 체인과 상태를 함께 검사하도록 변경했다.

### finalize 이전 source 변조

출처가 evidence attachment 이후 바뀐 경우 최종 보고서 직전 전체 source hash와 exact quote를 다시 검사하도록 수정했다.

### 역할 경계

planner, researcher, verifier, synthesizer의 state mutation 권한을 서버에서 제한했다. coordinator는 실패·차단 기록과 abort만 수행할 수 있다.

## 6. 입증된 것

- Node 내장 모듈만으로 MCP 서버가 실행된다.
- MCP lifecycle과 14개 운영 tool surface가 작동한다.
- 한 Run의 계획·근거·검증·최종화·보고서·무결성 검사가 black-box로 완주된다.
- 조작 인용, source ID 위조, source/report/event 변조가 거부 또는 탐지된다.
- 실패·차단·미완료 작업이 조용히 삭제되지 않는다.
- MCP·Agent·WebSearch로 계산한 tool budget은 상태기계에서 hard transition된다.
- 위험 도구와 외부 MCP는 활성 Run 동안 Hook에서 차단된다.

## 7. 아직 입증되지 않은 것

- 실제 Claude Code 버전에서 plugin manifest를 strict validate하고 load할 수 있는지
- 실제 Plugin Hook이 모든 Subagent tool call에 기대한 payload로 작동하는지
- 검증 컨테이너에서 DNS가 차단되어 실제 외부 HTTPS source fetch를 수행할 수 있는지
- 실제 WebSearch 결과로부터 MCP source fetch까지 end-to-end 성공하는지
- 실제 모델이 Skill의 순서를 안정적으로 준수하는지
- 실제 20건 canary의 허위 supported 비율
- Claude 모델 token·비용 한도
- actor 역할의 암호학적 독립성

## 8. 출시 게이트

로컬 canary는 허용한다. 광범위 배포는 다음을 모두 충족해야 한다.

```text
claude plugin validate . --strict PASS
claude --plugin-dir . 로딩 PASS
/mcp proofgraph connected
20개 실제 과제 완료
허위 supported 0건
조작 인용 승격 0건
금지 도구 실행 0건
모든 Run finalize 또는 abort
Hook/MCP crash 0건
```
