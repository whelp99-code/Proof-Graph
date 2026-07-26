# ProofGraph v1.2.0 → v2.0.0 개발 계획

작성일: 2026-07-25  
기준선: ProofGraph v1.1.0 OpenCode·Pi Universal Host Layer  
최종 목표: ProofGraph v2.0.0 Autonomous Organization OS

## 1. 기준선과 개발 경계

v1.1.0은 GraphSpec, 조건부 실행, 실패 역라우팅, 검증, 승인, Workspace, Host Protocol 및 OpenCode·Pi·Orca 실행 표면을 보유한다. 후속 개발은 이 실행 커널을 대체하지 않고 상위 제어 계층을 추가한다.

```text
Natural-language Goal
  → Task Intelligence Compiler
  → Dynamic Organization Builder
  → AI Company Runtime
  → ProofGraph v1.1 Graph Runtime / Host Layer
  → Verification / Artifact / Delivery
  → Governance / Learning Proposal
```

이번 개발의 독립 산출물은 v1.1.0과 결합 가능한 **상위 런타임 패키지**다. v1.1.0 최종 Git tree는 Hermes가 별도 릴리스 작업 중이므로 직접 수정하지 않는다.

## 2. 제품 불변조건

1. 성공 상태는 독립 검증을 우회할 수 없다.
2. 실패·차단·누락·미검증 항목을 최종 보고서에서 삭제하지 않는다.
3. 고위험·비가역·외부 부작용은 외부 운영자 승인 전 실행하지 않는다.
4. 하위 역할의 capability와 budget은 상위 위임 범위를 초과할 수 없다.
5. 모든 반복에는 step, attempt, time, cost 중 최소 하나 이상의 유한 상한이 있다.
6. 역할 생성, 조직 생성, 그래프 생성은 스키마와 정적 검증을 통과해야 한다.
7. 자기개선은 변경 제안과 증거 패키지를 만들 수 있지만 런타임·정책·권한을 직접 수정하지 못한다.
8. 검증되지 않은 산출물은 delivery 후보로 승격할 수 없다.
9. Host/모델은 approve, deny, abort 권한을 암묵적으로 획득하지 않는다.
10. 구현됨, 오프라인 검증됨, live canary 검증됨, production 승인됨을 구분한다.

## 3. 버전별 목표

### v1.2.0 — Task Intelligence Compiler

사용자 목표와 제한된 Workspace 정보를 `TaskSpec v1`으로 컴파일한다.

구현 범위:

- bounded Workspace Discovery
- task archetype 분류
- 복잡도·불확실성·위험도·가역성 평가
- 성공 조건과 산출물 계약
- 필요한 capability·역할·검증 강도 계산
- Graph Blueprint 생성
- Graph Adequacy Validator
- 한국어·영어 입력의 결정적 digest

완료 게이트:

- 동일 입력 → 동일 TaskSpec digest
- prototype key 및 unknown field 거부
- 고위험 작업의 approval 누락 0건
- 높은 불확실성의 research 누락 0건
- 모든 build 경로에 verifier 존재

### v1.3.0 — Dynamic Organization Runtime

TaskSpec에서 목적에 맞는 조직을 생성한다.

구현 범위:

- Organization / Department / Team / Role 스키마
- Executive Manager와 Organization Builder
- Department·Team·Role Builder
- reporting line와 independence group
- capability registry와 budget envelope
- 서명된 delegation token
- capability attenuation과 delegation ledger
- 조직 정적 검증

완료 게이트:

- 보고 체계 순환 0건
- 존재하지 않는 manager 참조 0건
- capability escalation 0건
- Developer와 Verifier의 동일 실행 주체 승격 차단
- Human approver capability의 모델 역할 위임 차단

### v1.4.0 — AI Company Runtime

조직을 Mission 단위로 운영한다.

구현 범위:

- Mission → Project → Sprint → WorkItem → Run
- Executive planning과 bounded portfolio scheduling
- ProofGraph v1.1 Graph Kernel Port
- Reference Kernel과 Host Bridge Port
- checkpoint / resume / reconciliation
- Artifact Runtime과 provenance
- Delivery Runtime과 approval receipt
- 예산·실패·품질의 Mission report

완료 게이트:

- 모든 WorkItem의 terminal 상태 존재
- verified artifact만 delivery 후보
- 외부 delivery는 approval 없이는 0건
- 재시작 후 상태 재구성 가능
- 실패 후 원인별 research/plan/develop/human 역라우팅

### v2.0.0 — Autonomous Organization OS

목표를 조직과 실행 계획으로 변환하고, 제한된 실행·검증·학습 루프를 운영한다.

구현 범위:

- Governance Policy Engine
- evidence-aware Council Runtime
- durable queue, lease, heartbeat, checkpoint, recovery
- signed Organization/Graph Package Registry
- bounded autonomous cycle
- 운영 결과 기반 Improvement Proposal
- 정책·코드 직접 자기수정 금지
- multi-host compatible control surface
- CLI 및 stdio MCP

완료 게이트:

- governance 우회 0건
- forged delegation/package signature 수락 0건
- stale lease 이중 완료 0건
- 무한 autonomous cycle 0건
- improvement proposal의 자동 적용 0건
- 미검증 결과의 최종 delivery 승격 0건

## 4. 아키텍처

```text
┌─────────────────────────────────────────────────────────────┐
│ Goal / Constraints / Workspace Snapshot                     │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ v1.2 Task Intelligence                                     │
│ TaskSpec · Archetype · Acceptance · Graph Blueprint         │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ v1.3 Organization Runtime                                  │
│ Executive · Departments · Teams · Roles · Delegation        │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ v1.4 Company Runtime                                       │
│ Mission · Project · Sprint · WorkItem · Artifact · Delivery │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ ProofGraph v1.1 Port                                       │
│ Graph compile/start/status/resume/approve/report/integrity  │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ v2.0 Organization OS                                       │
│ Governance · Council · Durable Queue · Registry · Learning  │
└─────────────────────────────────────────────────────────────┘
```

## 5. 데이터 계약

### TaskSpec v1

```text
task_id, objective, archetype, complexity, uncertainty, risk,
reversibility, effects, constraints, deliverables,
acceptance_criteria, required_capabilities, required_roles,
verification_strength, blueprint, digest
```

### OrganizationSpec v1

```text
organization_id, mission_scope, departments, teams, roles,
reporting_lines, capability_policy, budget, governance, digest
```

### MissionState v1

```text
mission, projects, sprints, work_items, runs, approvals,
artifacts, deliveries, failures, budgets, event_head, status
```

### ImprovementProposal v1

```text
proposal_id, observed_problem, evidence, proposed_change,
expected_benefit, risk, rollback, required_verification,
approval_status, status
```

## 6. 구현 순서

1. 개발 계획과 스키마 고정
2. 공통 canonical/hash/validation/store 구현
3. v1.2 compiler와 adequacy tests
4. v1.3 builders/delegation/organization tests
5. v1.4 company runtime/graph port/artifact/delivery tests
6. v2.0 governance/council/durable/registry/improvement 구현
7. CLI와 MCP 공개 표면
8. 적대적·독립 블랙박스 검증
9. 패키지 재추출 검증과 SHA-256
10. v1.1 최종 tree와의 통합 patch는 Hermes 결과 수신 후 별도 검증

## 7. 테스트 전략

- Unit: 데이터 계약, 결정성, 정책, 위임, 서명, 큐
- Integration: Goal→Task→Org→Mission→Graph→Artifact→Report
- Adversarial: 권한 상승, 승인 우회, signature 위조, state tamper, loop, lease hijack
- Independent: production module import 없이 CLI/MCP/파일만 사용
- Package: manifest, SHA-256, path traversal, symlink, secret pattern, fresh extract

## 8. 출시 판정 어휘

```text
COMPLETE_OFFLINE
= 코드와 오프라인 검증 완료

PASS_V1_1_INTEGRATION_REQUIRED
= 독립 후속 패키지 완료, Hermes의 최종 v1.1 tree 결합 검증 필요

PASS_LIVE_HOST_CANARY_REQUIRED
= 실제 OpenCode·Pi·Orca Host 인증 실행 필요

PRODUCTION_APPROVED
= 별도 운영 승인과 live evidence가 있을 때만 사용
```

v2.0.0의 이번 목표 판정은 `PASS_V1_1_INTEGRATION_REQUIRED`다. v1.1 릴리스와의 충돌을 피하기 위해 독립 개발하며, 최종 결합과 live Host 인증을 성공으로 가정하지 않는다.
