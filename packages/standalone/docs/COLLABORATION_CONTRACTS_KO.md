# Collaboration Contract Runtime

Agent 간 자유형 채팅 대신 versioned WorkContract와 HandoffPacket을 사용한다.

## WorkContract 상태

```text
proposed
acknowledged
rejected
blocked
completed
cancelled
```

Contract는 producer, consumer, subject, deliverables, acceptance criteria, evidence requirements, input refs, idempotency key와 digest를 가진다.

## 자동 생성

- dependency 완료 후 다음 역할에 handoff 계약
- verification 역할에 독립 검증 계약
- API·service·file·test·artifact 영향 발견 시 QA/Risk 후속 계약

## 안전 규칙

- consumer 없는 계약 금지
- producer 하나만 consumer인 self-only 계약 금지
- evidence/output reference 없는 완료 금지
- 동일 idempotency key 중복 생성 방지
- terminal 시 proposed/acknowledged 계약이 남으면 quality gate 차단
