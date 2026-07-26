# ProofGraph v2.0.0 릴리스 노트

## 판정

`PASS_V1_1_INTEGRATION_REQUIRED`

Task Intelligence, Dynamic Organization, AI Company Runtime, Autonomous Organization OS의 코드와 오프라인 검증을 완료했다. Hermes가 확정하는 v1.1.0 tree와의 실제 결합 및 OpenCode·Pi·Orca live canary는 별도 게이트다.

## 핵심 기능

- 자연어 목표의 TaskSpec 컴파일
- 역할·부서·팀 자동 생성
- capability·budget 감쇠 위임
- Mission 계층과 실패 역라우팅
- 독립 검증 기반 artifact 승격
- 사람 승인 기반 고위험 정지
- durable queue
- 서명 package registry
- evidence-aware Council
- proposal-only learning

## 호환성

- Node.js >=20
- v1.1 `proofgraph.host.v1` Port
- 외부 runtime dependency 없음

## 업그레이드

이 패키지는 v1.1을 덮어쓰는 단순 파일 교체가 아니다. 별도 workspace package로 추가한 후 v1.1 Host Bridge에 연결한다. 정확한 통합 diff는 Hermes 최종 v1.1 tree 수신 후 생성해야 한다.


## 검증 수치

```text
Unit:          48/48 PASS
Integration:   30/30 PASS
Adversarial:   31/31 PASS
Total:         109/109 PASS
Independent:   18/18 PASS (production imports 0)
Coverage:      95.03% line / 78.06% branch (관측 최소값) / 92.43% function
Preflight:     13 PASS / 0 FAIL / 4 SKIP
```

## v2.0 최종 보안 보강

- workspace 2 MB, metadata 256 KB, OS 전체 입력 2.5 MB 상한
- 숨은 OS control field와 비정상 `max_cycles` 선제 거부
- 전체 검증 입력에 결합된 deterministic OS run ID
- 데이터 디렉터리별 난수 approval secret
- proposal-bound persisted external Delivery approval
- Mission/OS 명시적 integrity·abort 운영 표면

Coverage branch 계측은 clean run에서 실행별로 소폭 변동하며 릴리스 문구는 관측 최소값 78.06%를 사용한다.
