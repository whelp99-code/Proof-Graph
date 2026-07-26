# ProofGraph Operator TUI 사용 및 화면 설계

## 목적

Operator TUI는 운영자가 JSON·로그 파일·여러 터미널을 직접 조합하지 않고도 AI 조직의 전체 실행 경로를 이해하고 통제하도록 한다.

## 화면 구성

```text
Header
├─ Run ID / 상태 / Host / 진행률 / 경과시간 / 연결 상태
Body
├─ Runs: 전체 실행 목록
├─ Main View: Graph / Organization / Cycles / Timeline / Failures
└─ Inspector: 선택 Node·Loop·Failure·Artifact 상세
Bottom
├─ Timeline
├─ Approval Queue
└─ Keymap
```

## 실행 그래프 기호

| 기호 | 의미 |
|---|---|
| `✓` | 완료 |
| `●` | 실행 중 |
| `Ⅱ` | 일시 정지 |
| `?` | 승인 대기 |
| `!` | 실패 |
| `×` | 차단·취소 |
| `○` | 대기 |
| `◇` | 다음 실행 가능 |
| `↺N` | N번째 시도 또는 반복 |

Retry Edge는 일반 의존선과 분리해 `↺ source → target failure_type iteration/max`로 표시한다.

## View

### Graph

- 현재 Node와 다음 Node
- Dependency Edge
- 실패 Return Edge
- Attempt와 Loop
- 1,000개 Node virtualization
- 완료 Node 접기

### Organization

- Department·Team·Role
- Manager 관계
- Verifier 독립 그룹
- 역할별 현재 WorkItem

### Cycles

- OS Cycle 번호
- 각 Cycle의 Mission 상태
- Council 결정
- Improvement Proposal

### Timeline

- 이벤트 시간순 목록
- `route.changed`, `loop.*`, `approval.*`, `mission.terminal`
- Event sequence와 actor

### Failures

- Historical
- Resolved
- Unresolved
- Failure type·severity·attempt·증거

## 운영 동작

| 키 | 동작 | 확인 절차 |
|---|---|---|
| `N` | 새 Mission | 목표 입력 |
| `P` | Pause/Resume | 즉시 실행, 감사 로그 |
| `R` | Node Retry | 선택 Node와 bounded attempt 검사 |
| `A` | 승인 | `YES` 재확인 |
| `D` | 거절 | `YES` 재확인 |
| `X` | Abort | `ABORT` 재확인 |
| `Q` | TUI 종료 | Runtime은 유지 |

## 안전 규칙

1. TUI는 `state.json`과 `events.jsonl`을 직접 수정하지 않는다.
2. 모든 명령은 Control Plane REST로 전송한다.
3. Approval challenge는 TUI에 전달되지 않는다.
4. 승인·거절·Abort는 명시적 재확인이 필요하다.
5. 모델·OpenCode Plugin에는 Operator Token을 제공하지 않는다.
6. UI 문자열은 ANSI escape와 제어문자를 제거한다.
7. 연결이 끊기면 SSE 재접속 후 projection snapshot으로 복구한다.

## 작은 터미널

화면 폭·높이가 줄어들면 다음 우선순위로 축소한다.

```text
상태·현재 Node·Failure·Approval
→ Graph 핵심 경로
→ Timeline 최신 이벤트
→ 상세 Organization/Artifact
```

TUI는 색상에만 의존하지 않고 기호와 텍스트 상태를 함께 표시한다.
