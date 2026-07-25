# ProofGraph v1.0.0 Dynamic Graph Engine 독립 검증

## 결과

```text
독립 블랙박스: 14/14 PASS
실패:           0
확정 잔여 위험: 1
```

검증기는 production module을 import하지 않고 stdio MCP, Hook subprocess, 상태·이벤트·보고서 파일을 사용했습니다.

검증 범위:

1. MCP version과 Graph tool surface
2. 동일 입력 Graph digest 결정성
3. direct Graph의 verified success
4. implementation failure의 Developer 역라우팅
5. 병렬 Research all-join
6. 고위험 Human Approval
7. bounded dynamic fan-out
8. route injection 차단
9. Agent/Tool guard
10. process restart 상태 유지
11. state tampering 탐지
12. report tampering 탐지
13. shell/workspace-write capability smuggling 차단
14. 사람 신원 self-attestation 잔여 위험 재현

출시 게이트는 전체 Platform 판정인 `PASS_OFFLINE_VENDOR_CANARY_REQUIRED`를 따릅니다.
