# ProofGraph v1.0.2 — Orca 통합 검증 보고서

## 판정

```text
PASS_OFFLINE_ORCA_LIVE_CANARY_REQUIRED
```

구현 대상은 strict Orca-native backend가 아니라 **ProofGraph Kernel + Orca Execution Host compatibility bridge**다.

## 결과

```text
전체 자동 시험                 184/184 PASS
적대적 시험                     49/49 PASS
Orca 계약·Preflight·적대적      20/20 PASS
Orca 독립 CLI 블랙박스          13/13 PASS
전체 독립 블랙박스              62/62 PASS
Preflight                        22 PASS / 0 FAIL / 1 SKIP
Coverage                         92.97% / ≥76.28% / ≥92.09%
```

## 핵심 방어

- Manual permission 확인과 명시적 repo selector 없이는 dispatch 불가
- ProofGraph Workspace와 Orca worktree 이중 소유 거부
- stale/wrong/duplicate completion 거부
- report path mismatch·traversal·symlink·malformed·missing 거부
- 병렬 대기는 non-consuming `orchestration check --all` 사용
- autonomous `orca orchestration run`과 ad-hoc `terminal send` 미사용
- 실제 mutation은 live canary 전 비활성

## 남은 실기 게이트

실제 Orca Desktop·CLI와 실제 Vendor Agent는 이 환경에서 실행하지 않았다. 사용자 Mac에서 read-only preflight와 최대 3-worker canary를 통과한 뒤에만 운영 범위를 확대한다.
