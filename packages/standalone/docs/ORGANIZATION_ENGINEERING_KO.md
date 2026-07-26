# Organization Engineering 설계

Graph Engineering이 node와 edge를 설계한다면 Organization Engineering은 목표에 맞는 책임·권한·보고·독립 검증 구조를 설계한다.

## 기본 구조

```text
Executive Manager
├─ Research Department
├─ Product and Planning
├─ Engineering Department
├─ Independent Quality Office
├─ Risk and Security Office
└─ Delivery Operations

External Human Governance
```

모든 Task가 모든 부서를 만들지는 않는다. 단순 답변은 Executive + Quality만 사용하고, 구현은 Planning·Engineering을 추가하며, 높은 불확실성은 Research를, 위험 작업은 Risk를, 외부 부작용은 Delivery를 추가한다.

## 역할 계약

```text
Role
- purpose
- capabilities
- delegable_capabilities
- budget
- manager_role_id
- independence_group
- model_eligible
```

## 위임

위임은 권한 복제가 아니라 감쇠다.

```text
child capabilities ⊆ parent token capabilities
child capabilities ⊆ child role capabilities
child budget       ⊆ parent remaining ceiling
child budget       ⊆ child role budget
```

Human approver와 operator capability는 모델 역할에 위임할 수 없다.

## 독립 검증

Developer와 Verifier는 다른 role ID와 independence group을 가져야 한다. 검증 성공은 producer의 자기 선언이 아니라 별도 verification report로만 artifact를 승격한다.
