# Hermes: ProofGraph v1.1.0 → v2.0.0 통합 작업지시서

## 1. 목적

Hermes가 확정한 ProofGraph v1.1.0 Git tree에 이 패키지를 **상위 workspace package**로 결합하고, 기존 Graph Runtime·Host Layer를 교체하지 않은 채 다음 계층을 추가한다.

```text
v1.1 Graph Runtime / Host Layer
        ↑ proofgraph.host.v1
v1.4 Company Runtime Graph Port
        ↑
v1.3 Dynamic Organization Runtime
        ↑
v1.2 Task Intelligence Compiler
        ↑
v2.0 Autonomous Organization OS
```

통합 대상 패키지:

```text
@proofgraph/organization-os@2.0.0
```

릴리스 게이트:

```text
PASS_V1_1_INTEGRATION_REQUIRED
```

## 2. 절대 경계

1. v1.1의 GraphSpec, ready-node 계산, 실패 역라우팅, 검증, 승인, Workspace 정책, terminal 상태 권위를 유지한다.
2. v2.0 패키지가 v1.1의 `approve`, `deny`, `abort`를 모델 호출 표면으로 노출하지 않게 한다.
3. v1.1 파일을 무차별 덮어쓰지 않는다.
4. `packages/organization-os/` 또는 동등한 workspace package로 먼저 추가한다.
5. v1.1 기존 시험과 v2.0 시험을 모두 유지한다.
6. live Host canary가 없는 기능을 production-ready로 승격하지 않는다.

## 3. 기준선 확인

Hermes가 실제 병합한 v1.1.0의 다음 값을 기록한다.

```text
main SHA
main tree SHA
package version
proofgraph.host protocol version
OpenCode Host target
Pi Host target
Orca compatibility status
전체 v1.1 test/independent/preflight 결과
```

초기 전달 artifact의 참고값은 다음이지만, **실제 Hermes 최종 tree가 권위자**다.

```text
참고 commit: 105abf960353430cf0f7db707df4b9a300f50a6a
참고 tree:   110980a2e5497df18b33d23be2c31f494970ddfd
```

값이 다르면 실패가 아니라 변경 원인을 기록하고 실제 final tree를 기준으로 통합한다.

## 4. 통합 절차

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/organization-os-v2

mkdir -p packages/organization-os
# v2.0.0 archive 내용을 위 디렉터리에 복사하되 .git, node_modules, dist 제외
```

루트가 npm workspace를 사용한다면:

```json
{
  "workspaces": [
    "packages/*"
  ]
}
```

기존 workspace 설정을 보존하여 병합한다. 루트 package manager와 lockfile 정책을 따른다.

## 5. v1.1 Graph Port 연결

v2.0은 다음 v1.1 명령만 모델 실행 포트에서 사용한다.

```text
필수: run, status, report, integrity
선택: compile, start, resume
운영자 전용: approve, deny, abort
```

`runtime/integration/v1-1-port.mjs`의 `proofgraph.host.v1` 계약을 실제 v1.1 Bridge와 대조한다.

필수 시험:

```text
Host identity 고정
Bearer 인증
remote HTTP 거부 또는 HTTPS 강제
expected_revision 충돌 처리
malformed report 실패 보존
integrity 실패 시 artifact 승격 차단
모델 표면에서 approve/deny/abort 부재
```

## 6. 통합 API

루트 Platform Factory 또는 상위 app에서 다음과 같이 주입한다.

```js
import { CompanyRuntime, AutonomousOrganizationOS } from '@proofgraph/organization-os';
import { createV11HostBridgePort } from '@proofgraph/organization-os/integration/v1.1';

const graphPort = createV11HostBridgePort({
  url: process.env.PROOFGRAPH_HOST_URL,
  token: process.env.PROOFGRAPH_HOST_TOKEN,
  host: 'opencode',
});

const company = new CompanyRuntime({
  dataDir: '.proofgraph/organization-os',
  graphPort,
});

const os = new AutonomousOrganizationOS({
  dataDir: '.proofgraph/organization-os',
  companyRuntime: company,
});
```

실제 constructor option 이름은 현재 소스와 대조하고, 추측하여 변경하지 않는다.

## 7. 필수 회귀 검증

### v1.1 전체

```bash
npm ci --ignore-scripts
npm test
npm run release:verify
npm run verify:hosts
npm run hosts:preflight
```

존재하는 실제 script 이름을 기준으로 실행한다.

### v2.0 package

```bash
cd packages/organization-os
npm ci --ignore-scripts
npm test
npm run coverage
npm run preflight
npm run verify:independent
npm run verify:package
```

현재 독립 패키지 기준 기대값:

```text
Unit:        48/48 PASS
Integration: 30/30 PASS
Adversarial: 31/31 PASS
Total:       109/109 PASS
Independent: 18/18 PASS
Preflight:   13 PASS / 0 FAIL / 4 SKIP
Coverage:    95.03 line / 78.06 branch (관측 최소값) / 92.43 function
```

통합 후 수치가 변하면 실제 결과를 기록하며, 감소한 시험은 이유 없이 삭제하지 않는다.

## 8. 교차 계층 적대적 검증

다음을 별도 통합 시험으로 추가한다.

1. Organization role이 v1.1 Verifier를 우회해 success terminal로 갈 수 없음.
2. 모델이 v2.0 MCP 또는 v1.1 Host Bridge로 approve/deny/abort를 호출할 수 없음.
3. v2.0 verified artifact 승격 전 v1.1 report integrity가 실패하면 차단됨.
4. 외부 Delivery approval이 Mission state의 `delivery_id + proposal_digest`와 다르면 adapter 호출 0회.
5. v1.1 Host가 timeout/malformed output을 반환하면 Failure Packet이 삭제되지 않음.
6. 중단 후 resume 시 WorkItem과 Graph Run mapping이 중복 실행되지 않음.
7. capability delegation이 v1.1 tool policy ceiling을 확장하지 못함.
8. active Host policy bridge 장애 시 mutation이 fail-closed됨.
9. OS retry가 v1.1 graph attempt/cycle 상한을 무력화하지 못함.
10. state/event/secret symlink 및 digest 변조가 교차 계층에서도 탐지됨.

## 9. Live Host canary

각 Host에서 대표 Mission 20건 이상을 수행한다.

```text
OpenCode: plugin/UI + pure worker 분리, diff, abort, resume
Pi: extension session persistence + strict agent_settled RPC
Orca: Task/Dispatch/worktree/terminal compatibility
```

기록 항목:

```text
정확한 Host 버전
인증 방식
성공률
p50/p95 지연
비용/토큰
malformed output
approval bypass
policy bypass
timeout/abort/resume
silent failure
```

live canary가 없는 Host는 `NOT_OBSERVED`로 남긴다.

## 10. 병합 조건

```text
v1.1 기존 CI PASS
v2.0 109개 이상 회귀 PASS
통합 적대적 시험 PASS
version/lockfile/workspace 일치
secret finding 0
verifier bypass 0
approval bypass 0
무한 loop 0
artifact false promotion 0
문서와 실제 기능 일치
```

## 11. 최종 보고

```text
v1.1 final main SHA/tree
integration branch/PR
v2 package path/version
v1.1 regression result
v2 regression result
cross-layer adversarial result
OpenCode/Pi/Orca canary result
remaining SKIP/NOT_OBSERVED
release decision
```

판정 어휘는 다음만 사용한다.

```text
INTEGRATED_OFFLINE
PASS_LIVE_HOST_CANARY_REQUIRED
PRODUCTION_APPROVED
BLOCKED
```
