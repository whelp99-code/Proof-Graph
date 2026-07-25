# ProofGraph v1.0.0 최종 릴리스 검증 보고서

## 1. 판정

```text
릴리스 게이트: PASS_OFFLINE_VENDOR_CANARY_REQUIRED
코드 구현:      COMPLETE
오프라인 검증:  PASS
외부 공급자 실기: REQUIRED
무인 운영 승인: NOT APPROVED
```

ProofGraph v1.0.0은 v0.6부터 v1.0까지 계획한 Graph Engineering 개발 도구의 코드·CLI·MCP·Workspace·Debugger·Template·Adapter 계약을 통합했고, 자동·적대적·독립 블랙박스 검증을 통과했습니다. 다만 이 빌드 환경에서는 Claude Code, Codex, OpenCode, Gajae Code, Grok, Pi의 실제 로그인·인증 호출을 수행하지 않았으므로 공급자별 운영 인증은 완료되지 않았습니다.

## 2. 순차 개발 결과

| 버전 | 목표 | 완료 상태 |
|---|---|---:|
| v0.6.0 | Adapter 독립 Universal Runtime Kernel | COMPLETE |
| v0.7.0 | Claude/Codex/OpenCode/Grok/Pi/GJC 확장 경계 | COMPLETE |
| v0.8.0 | 승인 기반 disposable Git Worktree | COMPLETE |
| v0.9.0 | Breakpoint·Step·Inspector·DOT Debugger | COMPLETE |
| v1.0.0 | CLI·ESM·범용 MCP·Template Registry 통합 | COMPLETE |

## 3. 자동 시험

| 구분 | 통과 | 실패 | Skip |
|---|---:|---:|---:|
| 단위 | 47 | 0 | 0 |
| 통합 | 24 | 0 | 0 |
| 적대적 | 40 | 0 | 0 |
| 플랫폼 | 36 | 0 | 0 |
| **전체** | **147** | **0** | **0** |

Coverage:

```text
Line:     92.24%
Branch:   ≥76.99% (반복 관측 76.99%–77.04%)
Function: 91.87%
```

## 4. 독립 블랙박스 검증

| 검증기 | 결과 | 잔여 위험 |
|---|---:|---:|
| Evidence Engine | 18/18 PASS | 1 |
| Dynamic Graph Engine | 14/14 PASS | 1 |
| v1 Platform | 10/10 PASS | 1 |
| **합계** | **42/42 PASS** | **3** |

독립 검증기는 production module을 직접 import하지 않고 CLI, stdio JSON-RPC/MCP, Hook subprocess, 저장 파일, 의도적 변조를 사용했습니다.

## 5. Preflight

```text
PASS: 19
FAIL: 0
SKIP: 1
TOTAL: 20
```

Skip은 `claude plugin validate . --strict`입니다. 검증 환경에 Claude CLI가 없기 때문에 실행하지 못했으며 성공으로 계산하지 않았습니다.

## 6. Adapter 계약 보정

- Claude: print mode + JSON + plan mode + write/shell deny
- Codex: `exec`, read-only sandbox, 설정 가능한 JSON/JSONL 출력 인자
- OpenCode: `run --format json --agent plan --dir ...`
- Grok: `--no-auto-update`, headless JSON, `--cwd`, `-p`
- Pi: 엄격한 LF JSONL RPC, Node `readline` 미사용
- GJC: v0.11 SDK v3 WebSocket 또는 명시적 trusted command profile만 허용하는 fail-closed 경계

모든 외부 Adapter는 기본 비활성입니다. Mock canary는 `CANARY_PASS`를 기록했지만 외부 공급자 canary는 모두 `NOT_RUN`입니다.

## 7. 검증된 보안·운영 불변조건

- 성공 경로는 Verifier를 우회할 수 없음
- Failure Packet 없이 실패 완료 불가
- 동일 오류 반복은 Developer→Planner/Human으로 승격
- 고위험 Graph는 challenge-bound approval 전 진행 불가
- Dynamic fan-out은 node·권한·병렬도 상한을 초과할 수 없음
- Workspace 변경은 action digest 승인 후에만 실행
- 경로 탈출, `.git`, symlink, shell 문자열, 비허용 명령 차단
- 직접 mutation 탐지 시 rollback
- Event chain·state·report·receipt 변조 탐지
- Inspector는 기본 loopback + bearer token
- 외부 공급자 Adapter는 live canary 전 production-ready가 아님

## 8. 패키지 검증

```text
BUILD_MANIFEST 파일: 141
실제 inventory:       141
Hash/size 불일치:      0
예상 밖 파일:          0
Secret pattern:        0
```

최종 JSON 증거도 BUILD_MANIFEST에 포함됩니다. 반복 검증 결과는 `verification/tmp/`에 기록되어 고정된 릴리스 증거를 덮어쓰지 않으며, 해당 임시 디렉터리는 package inventory와 최종 ZIP에서 제외합니다.

## 9. 잔여 위험

1. Verifier/Agent 역할은 논리적 신원이며 암호학적 독립 신원이 아닙니다.
2. 동일 Host 안의 approval challenge는 실제 사람의 신원을 암호학적으로 증명하지 않습니다.
3. Git worktree는 파일 격리이며 네트워크·커널 격리가 아닙니다.
4. 외부 CLI·SDK의 버전 변화는 오프라인 계약 시험만으로 완전히 검증할 수 없습니다.

## 10. 최종 결론

v1.0.0 소스 릴리스와 로컬 Graph Engineering 플랫폼은 출시 가능한 오프라인 상태입니다. 실제 운영에서는 사용할 공급자 버전을 고정하고, 인증된 live canary와 외부 sandbox 정책을 추가한 뒤 Adapter별로 production-ready 상태를 승격해야 합니다.
