# ProofGraph v1.0.2 Orca 통합 릴리스 검증

## 최종 판정

```text
PASS_OFFLINE_ORCA_LIVE_CANARY_REQUIRED
```

v1.0.2는 ProofGraph Graph Runtime과 Orca의 Task·worktree·terminal·Dispatch를 연결하는 **Execution Host Compatibility Bridge**를 구현했다. 실제 Orca Desktop과 인증된 Claude/Codex/OpenCode 프로세스는 이 빌드 환경에 없었으므로, 오프라인 계약 검증과 실제 사용자 Mac의 live canary를 구분한다.

## 구현 경계

```text
ProofGraph
- GraphSpec·ready node·라우팅·검증·승인 정책·최종 상태의 권위자

Orca
- 운영 UI·Git worktree·terminal·agent process·Task/Dispatch 전달의 권위자
```

ProofGraph는 Orca의 자동 coordinator loop를 호출하지 않는다. 각 Node를 수동 추적 흐름인 `task-create → worktree create → terminal wait → dispatch --inject → check --all --wait`로 실행한다.

## 검증 결과

| 항목 | 결과 |
|---|---:|
| 전체 자동 시험 | **184/184 PASS** |
| 적대적 시험 | **49/49 PASS** |
| Orca 계약·Preflight·적대적 시험 | **20/20 PASS** |
| Evidence 독립 블랙박스 | **18/18 PASS** |
| Graph 독립 블랙박스 | **14/14 PASS** |
| Platform 독립 블랙박스 | **10/10 PASS** |
| TUI 독립 블랙박스 | **7/7 PASS** |
| Orca 독립 블랙박스 | **13/13 PASS** |
| 독립 블랙박스 합계 | **62/62 PASS** |
| Preflight | **22 PASS / 0 FAIL / 1 SKIP** |
| Coverage | **line 92.97% / branch ≥76.28% / function ≥92.09%** |

Preflight의 1개 Skip은 검증 환경에 Claude CLI가 없어 `claude plugin validate . --strict`를 실행하지 못한 항목이다. 통과로 계산하지 않았다.

재추출 검증 중 ZIP 해제 환경에서 JavaScript CLI shim의 실행 권한 비트가 보존되지 않는 결함을 재현했다. preflight bridge가 `.mjs/.js/.cjs` shim을 현재 Node 런타임으로 실행하도록 수정했고, 재압축·재추출 후 전체 릴리스 검증을 다시 수행했다.

## 검증한 Orca 불변조건

- Orca Agent Permissions를 Manual로 확인하지 않으면 dispatch 전 fail-closed
- `orca repo list --json`에서 얻은 명시적 `id:<repoId>` selector가 없으면 dispatch 전 fail-closed
- ProofGraph Workspace Engine과 Orca worktree가 동시에 격리를 소유하면 거부
- live canary 전 workspace mutation capability 거부
- 한 Node attempt를 하나의 Orca Task와 fresh Dispatch context에 연결
- 완료는 활성 `taskId + dispatchId`와 일치하는 단일 `worker_done`만 수락
- stale·missing-dispatch·wrong-task·duplicate completion 거부
- 병렬 waiter는 non-consuming `check --all`을 사용해 메시지를 서로 소비하지 않음
- worker report는 계약된 worktree-relative exact path만 허용
- absolute·traversal·mismatch·symlink·malformed·missing·oversized report 거부
- stale terminal handle을 다시 조회하여 복구
- timeout은 즉시 실패가 아니라 bounded checkpoint로 처리
- `orca orchestration run`, `reset`, ad-hoc `terminal send`, `exec`, `computer`를 tracked 실행에서 사용하지 않음
- credential/security escalation을 non-retryable `security_risk` Failure Packet으로 보존

## 독립 검증 경계

Orca 독립 검증기는 ProofGraph production module을 import하지 않았다. public `proofgraph` CLI, 별도 fake `orca` subprocess, 설정 파일, persisted state/report/integrity artifact만 사용했다.

## 아직 검증하지 못한 부분

- 사용자의 실제 macOS Orca runtime 및 실제 Orca CLI JSON shape
- 설치된 Orca 버전에서 `check --all --wait` 병렬 계약
- 실제 Claude/Codex/OpenCode worker의 preamble 준수
- Orca 재시작 후 장시간 Dispatch·Decision Gate 연속성
- Remote Orca Server·SSH worktree의 report transport
- workspace mutation·push·merge·PR·deploy

## 출시 허용 범위

```text
읽기 전용 Orca preflight              GO
최대 3-worker 읽기 전용 canary       GO
로컬 compatibility bridge             조건부 GO
workspace mutation                    NO-GO
Remote/SSH worktree                   NO-GO
strict Orca-native 표기               NO-GO
조직 전체 무인 운영                  NO-GO
```
