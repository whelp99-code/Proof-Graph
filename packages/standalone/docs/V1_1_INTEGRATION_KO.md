# ProofGraph v1.1.0 → Intelligence v4.0.0 통합 가이드

## 목적

Hermes가 확정한 v1.1.0 Graph Runtime·OpenCode·Pi Host Layer에 v4.0.0 조직·Operator·Intelligence 상위 런타임을 결합한다.

```text
ProofGraph v4 Intelligence / Organization / Operator
                  │ proofgraph.host.v1
                  ▼
ProofGraph v1.1 Graph Runtime / Host Bridge
                  │
                  ├─ OpenCode
                  ├─ Pi
                  ├─ Claude
                  └─ Orca
```

## 결합 원칙

- v1.1 Graph Runtime을 복제하거나 우회하지 않는다.
- `proofgraph.host.v1`의 `run`, `status`, `report`, `integrity`를 실제 계약으로 사용한다.
- Ready Node, Workspace mutation, Graph terminal state는 v1.1 권위다.
- v4는 Task·Organization·Mission·Context·Route·Contract·Knowledge·Memory·Operator projection을 관리한다.
- exact model ID와 Intelligence bundle digest를 Host 요청에 포함한다.
- Host report로 ModelObservation을 생성하되 Registry 정책은 자동 변경하지 않는다.
- approve·deny·abort·pause·resume·retry는 외부 Operator 경로만 사용한다.

## 권장 저장소 구조

```text
Proof-Graph/
├─ 기존 v1.1 runtime·host 코드
└─ packages/
   └─ intelligence/
      ├─ runtime/
      ├─ bin/
      ├─ docs/
      └─ package.json
```

workspace package 또는 별도 패키지 dependency로 결합한다. v1.1 파일을 대량 덮어쓰지 않는다.

## Port 예시

```js
import { createV11HostBridgePort } from '@proofgraph/intelligence/integration/v1.1';

const port = createV11HostBridgePort({
  url: 'http://127.0.0.1:8743',
  token: process.env.PROOFGRAPH_HOST_TOKEN,
  host: 'opencode',
});
```

## 필수 교차 계층 시험

1. exact model ID와 실제 Host 실행 모델 일치
2. ContextPacket과 bundle digest 보존
3. malformed/timeout/revision conflict report의 Failure Packet 변환
4. v1.1 Verifier 실패를 v4가 success로 오판하지 않음
5. Host가 approve·deny·abort를 호출할 수 없음
6. registry drift 상태에서 Mission resume 차단
7. nested secret redaction과 restricted classification
8. WorkContract evidence/output 없는 completion 차단
9. critical actionable impact 미해결 시 terminal 차단
10. unverified Memory를 factual Context에 포함하지 않음
11. ModelObservation 변조 탐지와 policy 자동 변경 금지
12. OpenCode disconnect/reconnect·permission·tool event 복구

## 통합 검증 순서

```bash
# v1.1 루트
npm ci --ignore-scripts
npm test
npm run release:verify

# packages/intelligence
npm ci --ignore-scripts
npm test
npm run coverage
npm run preflight
npm run verify:independent
npm run verify:operator
npm run verify:intelligence
npm run verify:package
```

그 후 인증된 Host·모델 canary를 수행한다.

## 완료 판정

```text
v1.1 기존 회귀 PASS
+ v4 174개 이상 전체 회귀 PASS
+ 독립 검증 44개 이상 PASS
+ exact model/Context/Report binding PASS
+ Verifier/Approval/Registry/Secret 우회 0
+ 실제 Host canary PASS
```

이 조건 전에는 공개 v1.1 exact-tree 통합이나 production-ready를 주장하지 않는다.
