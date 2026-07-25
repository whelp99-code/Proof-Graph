# ProofGraph v1.0.0 Graph 적대적 검증

Graph 관련 자동 적대적 시험과 독립 검증은 다음 공격을 차단하거나 탐지했습니다.

- Verifier 우회 route injection
- `recommended_route` 정책 덮어쓰기
- 잘못된 approval challenge
- dynamic node shell/workspace-write 권한 삽입
- non-planner fan-out
- oversized output
- verifier success/failed verification 모순
- Failure Packet 누락
- state/report tampering
- prototype-pollution key
- arbitrary compiler blueprint

확정 잔여 위험은 동일 Host가 challenge를 가진 상태에서 `actor: human`을 자기신고할 수 있다는 점입니다. 이는 감추지 않고 release gate에 포함합니다.
