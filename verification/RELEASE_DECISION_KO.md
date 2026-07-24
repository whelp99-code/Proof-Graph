# v0.2.0 출시 판정

## 판정

**오프라인 MVP 빌드: 승인**  
**로컬 Claude Code canary: 승인**  
**조직 전체 또는 무인 운영: 보류**

## 근거

- 자동 시험 60/60
- 적대적 시험 21/21
- 독립 black-box 18/18, 실패 0
- Preflight 14개 실행 검사 PASS, Claude CLI strict validation 1개 SKIP, 실패 0
- 외부 npm runtime dependency 0
- 운영 MCP test-only tool 노출 0
- 문서화된 잔여 위험 1: actor identity self-attestation

## 보류 이유

검증 환경에 Claude Code CLI와 인증 세션이 없어 실제 host loading, `/mcp`, `/hooks`, 실제 Subagent, 실제 WebSearch를 실행하지 못했다.

## 다음 단일 게이트

사용자 환경에서 다음을 수행한다.

```bash
node scripts/preflight.mjs
claude plugin validate . --strict
claude --plugin-dir .
```

Claude Code에서:

```text
/mcp
/hooks
/proofgraph-claude:research <검증 대상>
```

20건 canary 조건을 충족하면 v0.2.1에서 실제 Claude 검증 결과를 release evidence에 편입한다.
