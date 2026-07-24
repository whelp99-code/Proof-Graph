# ProofGraph Claude MVP 아키텍처

## 설계 결정

1차 MVP는 **Claude Code 플러그인 + 내장 stdio MCP 서버 + 결정론적 Hook**으로 구성한다.

MCP만 단독 제공하면 설치·Skill·Subagent·Hook을 함께 배포하기 어렵고, 플러그인만 프롬프트로 구성하면 상태·예산·검증을 모델 판단에 의존하게 된다. 두 방식을 결합해 플러그인은 Claude 측 오케스트레이션을, MCP는 결정론적 상태기계를 담당한다.

## 구성요소

### Skill

`/proofgraph-claude:research`가 유일한 사용자 진입점이다. 자동 모델 호출을 비활성화해 사용자가 명시적으로 실행한다.

### Subagent

- `planner`: 고정 3역할 계획과 원자적 주장 등록
- `researcher`: 두 인스턴스가 병렬로 서로 다른 출처를 수집
- `verifier`: 증거를 다시 확인하고 방향성 판정 기록
- `synthesizer`: 서버의 결정론적 finalize와 보고서 반환

### Hook

- `PreToolUse`: 활성 Run 동안 허용 목록 외 도구 차단, Agent·WebSearch 예산 예약
- `PostToolUse`·`PostToolUseFailure`: 원문 대신 입력·응답·오류 해시 감사 기록
- `Stop`: 미완료 Run의 조용한 종료 차단
- 세션·Subagent 이벤트: 해시 기반 감사 이벤트 기록

### MCP 서버

newline-delimited JSON-RPC stdio 서버다. 초기화 협상 뒤 `tools/list`, `tools/call`을 제공한다. 운영 모드에서 14개 도구를 노출하고, 네트워크 없는 시험 모드에만 fixture import 도구를 추가한다.

## 상태 모델

```text
active
├─ finalized
├─ aborted
└─ budget_exceeded
```

실행 상태는 원자적 파일 교체와 파일 잠금을 사용한다. 각 변경은 append-only 이벤트와 `state.committed` 이벤트를 생성하며, 상태 digest가 이벤트 체인과 연결된다.

## 증거 모델

```text
Claim
 ├─ producer role
 ├─ Evidence[]
 │   ├─ server-fetched Source
 │   ├─ exact normalized quote
 │   ├─ source content hash
 │   └─ supports/refutes/context
 └─ Verdict[]
     ├─ verifier role
     ├─ evidence IDs
     └─ supported/refuted/mixed/insufficient
```

최종 분류는 distinct hostname 수, 정확 일치 근거, 프롬프트 인젝션 제외, verifier 판정으로 계산한다. caller가 finalize 입력에 분류를 넣을 수 없다.

## 실패 의미론

- 작업은 `pending`, `success`, `failed`, `blocked` 중 하나다.
- 실패·차단 작업은 보고서에서 삭제하지 않는다.
- 미완료 작업이 있으면 finalize를 거부한다.
- 예산 초과 시 상태가 `budget_exceeded`로 바뀌고 추가 open-world 작업을 차단한다.
- state가 삭제·손상돼도 Hook은 fail-open하지 않고 fail-closed한다.
