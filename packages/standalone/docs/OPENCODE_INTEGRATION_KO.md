# OpenCode 통합 가이드

## 통합 계층

ProofGraph는 OpenCode를 두 개의 분리된 경로로 연결한다.

```text
1. Execution Bridge
   ProofGraph WorkItem → proofgraph.host.v1 → OpenCode 실행 결과

2. Observability Bridge
   OpenCode Plugin → Host Ingest API → TUI Host/Session/Tool 상태
```

Observability Plugin이 실행 권한이나 Operator 권한을 가지지는 않는다.

## 설치

```bash
proofgraph install-opencode --project /absolute/project/path
```

생성 파일:

```text
.opencode/plugins/proofgraph-observer.js
.opencode/commands/pg-status.md
.opencode/commands/pg-flow.md
.opencode/commands/pg-approvals.md
.opencode/commands/pg-run.md
.opencode/proofgraph.json
```

환경:

```bash
export PROOFGRAPH_CONTROL_URL=http://127.0.0.1:8742
export PROOFGRAPH_HOST_TOKEN="$(cat .proofgraph-org/.host-ingest-token)"
```

Operator Token은 OpenCode 환경에 넣지 않는다.

## Observer Event

- generic OpenCode events
- `tool.execute.before`
- `tool.execute.after`
- session ID
- project ID
- Run/Node binding environment

Plugin은 다음을 적용한다.

```text
민감 key 마스킹
문자열 길이 제한
배열·객체 개수 제한
중첩 깊이 제한
1.5초 전송 timeout
관측 실패 시 OpenCode 실행 비차단
```

## 실제 WorkItem 실행

v1.1 Host Bridge를 실행한 뒤 `proofgraphd`에 연결한다.

```bash
proofgraphd \
  --data-dir .proofgraph-org \
  --bridge-url http://127.0.0.1:8743 \
  --bridge-token "$PROOFGRAPH_HOST_BRIDGE_TOKEN" \
  --runtime-host opencode
```

Host Bridge는 `proofgraph.host.v1`의 `run`, `status`, `report`, `integrity` 계약을 제공해야 한다. approve·deny·abort는 Operator-only이며 Bridge Graph Port에서 호출할 수 없다.

## 상태 의미

```text
OpenCode session.status = idle
≠ ProofGraph Mission completed

OpenCode tool.execute.after
≠ ProofGraph verification passed
```

ProofGraph는 Host 결과를 받은 후 독립 Verifier와 Artifact Gate를 적용한다. 실패하면 `route.changed`에 따라 Develop·Plan·Research 또는 Human Approval로 되돌린다.

## 검증 상태

오프라인 릴리스에서는 가짜 OpenCode 서버로 다음을 검증했다.

- `GET /global/health`
- `GET /project/current`
- `GET /global/event` SSE
- reconnect 및 session 상태 projection
- Observer event ingest
- Host Token과 Operator Token 분리

실제 설치·인증된 OpenCode canary는 별도 릴리스 게이트다.
