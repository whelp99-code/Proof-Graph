# Context Delivery Runtime

## 목표

모든 Agent에 전체 대화와 전체 Mission을 보내지 않고, 역할과 WorkItem에 필요한 최소 정보만 전달한다.

## ContextPacket

```text
packet_id
mission_id / work_item_id / role_id / role_type
classification
policy.sections / max_bytes / max_source_age_s / reject_stale_sources
sections
sources[] {
  type, id, digest,
  observed_at, source_updated_at,
  age_seconds, oldest_age_seconds,
  freshness, stale
}
redactions[]
dropped_sections[]
stale_source_count / unknown_freshness_source_count
byte_size / token_estimate
digest
```

역할별 기본 정책은 researcher, planner, developer, verifier, synthesizer에 따라 다르다. Verifier에는 producer의 `self_assessment`, `recommended_verdict`, 장황한 자기 설명을 제거한 blind context를 전달한다.

## Source freshness

- source 시점을 알 수 있으면 `fresh` 또는 `stale`로 표시한다.
- 시점을 알 수 없으면 `unknown`으로 보존한다.
- `max_source_age_s`를 넘는 source는 stale counter에 포함된다.
- `reject_stale_sources: true`면 packet 생성 전에 fail-closed한다.
- freshness 표시는 노후도를 알려줄 뿐 원문의 의미적 진실성을 보증하지 않는다.

## 보안

- nested secret-like **leaf key** 마스킹
- API key·Bearer·private-key 패턴 마스킹
- 사용자 홈 절대 경로 마스킹
- Context 최대 byte와 source 수 제한
- circular/non-finite/oversized JSON 거부
- packet/source digest와 freshness consistency 검증

정확 인용이나 factual provenance가 필요한 업무는 Context source reference에서 원 Artifact/Report로 역추적한다.
