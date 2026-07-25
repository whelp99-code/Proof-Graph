# ProofGraph Claude v0.5.0 통합 적대적 검증 보고서

## 결과

```text
기존 증거 엔진 적대적 시험   21/21 PASS
Graph 엔진 적대적 시험        13/13 PASS
전체                           34/34 PASS
방어·탐지 성공                 32
문서화된 잔여 위험              2
실패                            0
```

두 잔여 위험은 다음과 같다.

1. verifier actor는 서버가 강제하는 canonical role이지만 별도 물리적 모델·계정·키라는 암호학적 증명은 없다.
2. approval challenge를 가진 동일 Claude host가 `human` actor를 자기신고할 수 있다.

## 기존 증거 엔진 공격 범위

- 조작 인용·임의 source ID
- 같은 hostname을 독립 출처로 위장
- prompt injection 출처의 자동 승격
- producer 자기검증
- final classification 주입
- 실패 task 삭제
- path traversal
- test-only tool의 production 노출
- Hook state 삭제·손상·semantic tampering
- source·event·report 변조
- 역할 간 mutation 위장

모든 공격은 거부되거나 integrity 검사에서 탐지됐다. 자세한 원래 시나리오는 기존 테스트 `tests/adversarial/adversarial.test.mjs`에 보존한다.

## Graph 엔진 공격 범위

- route injection에 의한 verifier 우회
- recommended route를 통한 서버 라우팅 덮어쓰기
- approval challenge 위조
- dynamic shell/write capability smuggling
- non-planner expansion
- output resource exhaustion
- verifier output 모순
- untyped failure
- graph state/report 변조
- prototype pollution
- arbitrary compiler blueprint 주입

세부 결과는 `GRAPH_ADVERSARIAL_REPORT_KO.md`를 참조한다.

## 해석 제한

이 검증은 오프라인 코드·프로토콜 검증이다. 실제 Claude Code host, 모델 행동, 실제 WebSearch, 계정 권한, UI 승인 이벤트는 canary에서 별도로 검증해야 한다.
