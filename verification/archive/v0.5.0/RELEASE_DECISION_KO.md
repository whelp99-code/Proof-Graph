# ProofGraph Claude v0.5.0 출시 판정

## 판정

**오프라인 v0.5.0 코드·패키지: 승인**  
**로컬 Claude Code artifact-only canary: 승인**  
**조직 전체·무인 운영: 보류**  
**workspace write·shell 자동 실행: 금지**

Release gate:

```text
PASS_OFFLINE_CLAUDE_CANARY_REQUIRED
```

## 근거

- 자동 시험 105/105 PASS
- 단위 47/47, 통합 24/24, 적대적 34/34
- 기존 evidence black-box 18/18 PASS
- graph black-box 14/14 PASS
- Preflight 16/16 reported PASS, Claude CLI strict validation 1 SKIP
- Node 내장 coverage line 93.07%, branch 80.71%, functions 94.69%
- production MCP tool 24개, test fixture tool 비노출
- 외부 npm runtime dependency 0
- default compiler의 workspace-write/shell capability 0

## 승인 범위

- `/proofgraph-claude:research` 읽기 전용 증거 조사
- `/proofgraph-claude:graph` artifact-only 동적 Graph Engineering
- 단순·병렬 리서치·계획·구현안·검증·사람 승인 상태
- 실패 역라우팅과 bounded retry
- local report/state/event integrity

## 보류 이유

검증 환경에 Claude Code CLI·인증 세션이 없어서 다음을 실제 host에서 실행하지 못했다.

- `claude plugin validate . --strict`
- plugin load와 `/mcp`, `/hooks`
- 실제 model tier별 Subagent
- 실제 AskUserQuestion approval UX
- 실제 WebSearch·HTTPS source fetch
- 20건 canary의 false-success 비율

## 다음 게이트

```bash
npm run release:verify
claude plugin validate . --strict
claude --plugin-dir .
```

Claude Code에서:

```text
/plugin
/mcp
/hooks
/proofgraph-claude:graph <실제 과제>
```

20건 canary에서 검증 우회·승인 우회·금지 tool·silent failure·허위 success가 모두 0일 때 v0.5.1 hardening evidence로 승격한다.
