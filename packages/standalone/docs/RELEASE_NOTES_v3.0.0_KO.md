# ProofGraph Operator v3.0.0 릴리스 노트

## 핵심 변화

ProofGraph의 실행 상태를 JSON과 여러 터미널에서 확인하던 방식을 하나의 실시간 TUI 운영 콘솔로 통합했다.

## 버전별 구현

- v2.0.1: Observability Contract와 명시적 상태
- v2.1.0: `proofgraphd` REST/SSE Control Plane
- v2.2.0: Read-only Operator TUI
- v2.3.0: Pause·Resume·Retry·Approve·Deny·Abort
- v2.4.0: OpenCode Client·Observer Plugin·Host Registry
- v2.5.0: Execution·Organization·Cycle Graph
- v3.0.0: `proofgraph start` GA packaging

## 검증

```text
자동 시험                    149/149 PASS
기존 CLI/MCP 독립 검증         18/18 PASS
Operator 독립 검증             15/15 PASS
Coverage                      95.69 / 75.85 / 90.22
```

## 승격 전 남은 게이트

- 인증된 실제 OpenCode 20건 canary
- Hermes v1.1.0 exact tree 통합 회귀
