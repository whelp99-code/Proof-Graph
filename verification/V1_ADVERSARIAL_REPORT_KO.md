# ProofGraph v1.0.0 적대적 검증 보고서

## 결과

```text
적대적 자동 시험: 40/40 PASS
Evidence 독립검증: 18/18 PASS
Graph 독립검증: 14/14 PASS
Platform 독립검증: 10/10 PASS
```

## 공격 표면과 결과

| 공격 범주 | 대표 시나리오 | 결과 |
|---|---|---|
| Graph 우회 | route injection으로 verifier 생략 | 차단 |
| 실패 은폐 | Failure Packet 없이 failed 제출 | 차단 |
| 승인 위조 | 잘못된 challenge, self-approve | 차단/잔여위험 기록 |
| 권한 상승 | dynamic node에 shell/workspace-write 삽입 | 차단 |
| 역할 사칭 | non-planner expansion, producer self-verification | 차단 |
| 상태 변조 | state.json 의미 필드 수정 | 탐지 |
| Event 변조 | events.jsonl chain 수정 | 탐지 |
| Report 변조 | finalize 후 report 수정 | 탐지 |
| Evidence 위조 | 가짜 quote/source ID | 차단 |
| 출처 독립성 위조 | 같은 hostname을 다중 출처로 계산 | 차단 |
| Prompt injection | 출처 본문 지시를 근거로 자동 승격 | 제외 |
| Workspace 탈출 | `..`, 절대 경로, `.git`, symlink | 차단 |
| Command injection | shell 문자열, 비허용 executable | 차단 |
| Mutation 우회 | Adapter가 승인 없이 직접 파일 변경 | 탐지 후 rollback |
| Debugger 노출 | public bind without override | 차단 |
| Config 오염 | prototype pollution key | 차단 |
| Adapter 오용 | 외부 공급자 기본 실행 | disabled/fail-closed |
| 출력 오염 | malformed/oversized Agent output | 오류로 보존 |

## 확정된 잔여 위험

- 역할 신원은 암호학적으로 attested되지 않습니다.
- 사람 승인 신원은 같은 Host 안에서 self-attestation 한계가 있습니다.
- Git worktree는 네트워크·커널 sandbox가 아닙니다.
- 공급자별 실제 권한과 event envelope은 live canary가 필요합니다.

이 보고서는 위 위험을 해결했다고 주장하지 않고, 테스트로 재현해 명시적으로 출시 경계에 포함합니다.
