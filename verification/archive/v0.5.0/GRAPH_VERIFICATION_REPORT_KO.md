# ProofGraph v0.5.0 Graph Engineering 독립 검증

검증일: 2026-07-25 KST  
환경: Linux x86_64, Node.js v22.16.0  
검증 방식: production module import 없이 stdio MCP·Hook subprocess·저장 artifact만 사용하는 블랙박스 하니스

## 판정

```text
Graph compiler/runtime 오프라인 검증       PASS
Graph 전용 독립 블랙박스                  14/14 PASS
Graph 적대적 검증                         13/13 PASS
실제 Claude Code host canary              NOT RUN
Release gate                              PASS_OFFLINE_CLAUDE_CANARY_REQUIRED
```

## 독립 블랙박스 범위

1. 운영 MCP가 v0.5.0과 10개 Graph tool을 노출하는지
2. 같은 입력의 compiler digest가 동일한지
3. direct → verify → synthesize → success 전체 lifecycle
4. verifier 구현 오류가 developer로 역라우팅되는지
5. 병렬 research shard의 all-join 동작
6. 고위험 workflow가 challenge-bound approval까지 정지하는지
7. planner의 제한된 dynamic fan-out과 join
8. worker의 route injection으로 verifier를 건너뛸 수 없는지
9. Hook이 unmatched agent·write·shell을 차단하는지
10. MCP process restart 뒤 상태가 유지되는지
11. 문법상 유효한 state 변조가 후속 mutation 전에 탐지되는지
12. finalized report 변조 탐지
13. dynamic capability smuggling 차단
14. 동일 Claude host의 human self-attestation 잔여 위험 특성화

결과:

```text
14/14 PASS
실패 0
production module import 0
문서화된 잔여 위험 1
```

## 입증된 동작

- 목적과 signal을 제한된 GraphSpec으로 결정론적 컴파일한다.
- simple/direct, parallel research, plan/develop, human-gated topology를 생성한다.
- ready/claim/running/complete 상태 전이가 파일 transaction과 event hash chain에 기록된다.
- verified success path, bounded cycle, high-risk approval, capability policy가 정적 검사된다.
- Failure Packet 유형에 따라 develop·plan·research·human/failed 경로로 복귀한다.
- 동일 implementation failure가 반복되면 developer에서 planner, 이후 human/failure로 승격된다.
- 동적 node 추가는 수량·병렬도·capability 상한 안에서만 가능하고 전체 graph를 재검증한다.
- terminal report와 graph state의 local integrity를 재계산할 수 있다.

## 아직 입증되지 않은 동작

- 실제 Claude Code의 plugin strict validation과 host loading
- 실제 Agent/Hook payload가 모든 지원 Claude Code 버전에서 동일한지
- 실제 Claude 모델이 `/proofgraph-claude:graph`의 30-step 제한과 node claim 계약을 안정적으로 따르는지
- `haiku`·`sonnet`·`opus` model tier의 계정별 가용성·비용·지연
- 실제 AskUserQuestion 이벤트와 approval resolution의 사용자 경험
- 실제 WebSearch 및 외부 HTTPS source retrieval
- workspace mutation과 shell execution: v0.5.0 기본 정책에서 의도적으로 미구현

## 실제 Claude canary 종료 조건

```text
claude plugin validate . --strict PASS
/plugin에서 proofgraph-claude 로드 확인
/mcp에서 proofgraph connected
/hooks에서 guard·audit·stop 확인
최소 20개 workflow 완료
검증 우회 0
승인 우회 0
금지 tool 실행 0
silent failure 0
모든 run finalize 또는 abort
MCP/Hook crash 0
```
