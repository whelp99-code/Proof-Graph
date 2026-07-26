# Knowledge Graph와 Organization Memory

## Knowledge Graph

실행 DAG와 별도로 업무·코드·산출물 관계를 표현하는 bounded property graph다.

Node:

```text
task, requirement, role, work_item, artifact,
file, api, service, test, decision, memory
```

Edge:

```text
depends_on, produces, consumes, modifies,
verifies, impacts, decided_by, supersedes, relates_to
```

보고서의 changed file/API/service/test와 명시적 relation을 ingest하고 N-hop 영향도를 계산한다. traversal depth, node/edge 수, 결과 수는 유한 상한을 가진다.

## Organization Memory

Mission 간 재사용할 verified Decision, Constraint, Artifact, Lesson, Failure, Verification, Preference를 저장한다.

```text
proposed → verified
         → rejected
verified → superseded
```

검증된 기억은 provenance source와 별도 verifier를 요구한다. producer가 자신의 기억을 self-verify할 수 없다. recall은 lexical token, tag, Knowledge neighborhood, Mission/Task/Role 연관도와 confidence를 이용하며 sensitivity가 요청 classification보다 높으면 반환하지 않는다.

## 경계

- Knowledge Graph는 외부 입력을 명령으로 실행하지 않는다.
- 영향 분석은 가능성/범위를 계산하며 실제 변경 권한을 부여하지 않는다.
- Memory의 inferred 내용은 proposal로 남고 자동 factual 승격되지 않는다.
- 현재 검색은 bounded lexical+graph 방식이며 vector database나 완전한 의미 검색을 주장하지 않는다.
