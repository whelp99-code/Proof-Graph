# proofgraphd Control Plane API

## 기본 원칙

- 기본 bind: `127.0.0.1`
- 기본 port: `8742`
- 명령: REST JSON
- 실시간 상태: SSE
- 운영 인증: `Authorization: Bearer <operator-token>`
- Host 관측 인증: `x-proofgraph-host-token: <host-ingest-token>`
- 두 Token은 서로 호환되지 않는다.

Token 파일:

```text
<data-dir>/.operator-api-token
<data-dir>/.host-ingest-token
```

## Public health

```http
GET /v1/health
```

Health만 무인증이며 Runtime 상태·경로·Token은 반환하지 않는다.

## Run

```text
GET    /v1/runs
POST   /v1/runs
GET    /v1/runs/:runId
GET    /v1/runs/:runId/graph
GET    /v1/runs/:runId/timeline?after=<seq>&limit=<n>
GET    /v1/runs/:runId/integrity
```

생성 요청 예:

```json
{
  "type": "mission",
  "objective": "인증 API를 구현하고 독립 검증하라",
  "signals": {
    "risk": "medium"
  },
  "auto_start": true
}
```

## Operator command

```text
POST /v1/runs/:runId/pause
POST /v1/runs/:runId/resume
POST /v1/runs/:runId/abort
POST /v1/runs/:runId/nodes/:nodeId/retry
POST /v1/runs/:runId/approvals/:approvalId/decision
```

Mutating request에는 `Idempotency-Key`를 사용한다. 동일 key의 성공 명령은 최초 결과를 반환하고, 실패 명령 재사용은 conflict로 처리한다.

Approval 요청 예:

```json
{
  "decision": "approved",
  "reason": "사람 운영자가 위험과 rollback을 검토함"
}
```

Approval challenge는 API 입력에도 출력에도 나타나지 않는다. Control Plane이 persisted state에서 찾아 Runtime에 전달한다.

## Approval과 Host

```text
GET  /v1/approvals
GET  /v1/hosts
POST /v1/hosts/opencode/connect
POST /v1/hosts/opencode/disconnect
POST /v1/hosts/:hostId/events
```

`/v1/hosts/:hostId/events`만 Host Ingest Token을 사용한다. 이 endpoint는 Run 명령 권한을 제공하지 않는다.

## SSE

```text
GET /v1/events
GET /v1/runs/:runId/events?after=<seq>
```

SSE는 다음을 제공한다.

- `run.updated` projection snapshot
- Runtime event (`route.changed`, `loop.entered` 등)
- `Last-Event-ID` 또는 `after` cursor 재접속
- heartbeat
- 동시 client 상한

## 오류

| HTTP | 의미 |
|---:|---|
| 400 | Validation error |
| 401 | 인증 실패 |
| 403 | Policy violation |
| 409 | Conflict 또는 idempotent failed command |
| 429 | Budget 또는 SSE client 상한 |
| 500 | Integrity 또는 내부 오류; fail-closed |

## 원격 운영

현재 GA 범위는 로컬 단일 운영자이다. `--allow-remote`는 명시적으로 켤 수 있지만 TLS·RBAC·reverse proxy가 포함되지 않으므로 일반 운영에 권장하지 않는다.
