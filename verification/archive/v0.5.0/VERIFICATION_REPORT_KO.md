# ProofGraph Claude v0.5.0 통합 독립 검증 보고서

검증일: 2026-07-25 KST  
대상: Claude Code Plugin + stdio MCP + fail-closed Hook + Dynamic Graph Compiler/Runtime  
환경: Linux x86_64, Node.js v22.16.0

## 1. 종합 판정

```text
오프라인 코드·프로토콜 릴리스          PASS
전체 자동 시험                         105/105 PASS
기존 증거 엔진 독립 블랙박스             18/18 PASS
Graph 엔진 독립 블랙박스                 14/14 PASS
통합 적대적 검증                         34/34 PASS
실제 Claude Code host canary             NOT RUN
조직 전체·무인 운영                      NO-GO UNTIL CANARY
로컬 artifact-only Claude canary         GO
```

현재 검증 환경에는 `claude` 실행 파일과 인증 세션이 없다. 따라서 `claude plugin validate`, 실제 plugin loading, 실제 Agent/Hook lifecycle, WebSearch는 통과로 간주하지 않았다.

## 2. 자동 시험

| 구분 | 결과 |
|---|---:|
| 단위 시험 | 47/47 PASS |
| 통합 시험 | 24/24 PASS |
| 적대적 시험 | 34/34 PASS |
| 전체 | 105/105 PASS |
| Node 내장 coverage | line 93.07%, branch 80.71%, functions 94.69% |
| 실패·취소·skip | 0 |

Graph compiler 주요 모듈 coverage:

| 모듈 | Line | Branch | Function |
|---|---:|---:|---:|
| `graph-compiler.mjs` | 99.69% | 91.46% | 100% |
| `graph-runtime.mjs` | 94.45% | 75.24% | 91.25% |
| `graph-spec.mjs` | 98.96% | 81.71% | 100% |

## 3. Preflight

```text
16/16 reported PASS
실제 실행 검사 15 PASS
Claude CLI strict validation 1 SKIP — CLI 없음
```

검사 범위:

- Node·package·plugin version alignment
- Skill·Agent·Hook·MCP component path와 frontmatter
- 모든 `.mjs` 구문
- 외부 runtime dependency 부재
- MCP lifecycle·24개 production tool surface·schema
- deterministic graph preview
- 활성 Run이 없을 때 Hook 무간섭
- Claude CLI가 존재하는 환경에서 strict plugin validation

## 4. 독립 블랙박스

### 기존 Evidence Engine

```text
18/18 PASS
production module import 0
잔여 위험 1: verifier role self-attestation
```

### Dynamic Graph Engine

```text
14/14 PASS
production module import 0
잔여 위험 1: human role self-attestation
```

두 verifier는 newline-delimited JSON-RPC stdio, Hook subprocess stdin/stdout, 저장 state/event/report의 black-box 표면만 사용한다.

## 5. v0.5.0에서 추가로 입증된 것

- Typed GraphSpec과 제한된 edge condition vocabulary
- 자연어 목표·명시 signal 기반의 deterministic graph compilation
- simple/direct, research fan-out, plan/develop, human gate topology
- 모든 success terminal 경로의 verifier 강제
- verifier/human이 없는 무제한 cycle 거부
- high-risk approval 및 write/shell capability escalation 거부
- ready/claim/running/complete 상태기계와 checkpoint/restart
- typed Failure Packet과 원인별 reverse routing
- 반복 failure의 plan/human 승격
- bounded dynamic expansion과 전체 graph 재검증
- Graph-aware agent/tool Hook enforcement
- JSON/Markdown terminal report와 local integrity

## 6. 알려진 제한

- 기본 developer는 artifact-only이며 workspace를 수정하지 않는다.
- approval human identity는 암호학적으로 attested되지 않는다.
- verifier agent identity 역시 동일 host 안의 declared role이다.
- heuristic assessment는 routing input이며 객관적 진실이 아니다.
- 모델 token과 계정 billing은 plugin이 hard-limit하지 않는다.
- 실제 Claude Code host compatibility와 20건 canary가 남아 있다.

## 7. 출시 게이트

현재 release gate:

```text
PASS_OFFLINE_CLAUDE_CANARY_REQUIRED
```

광범위 배포 전 필수 조건:

```text
claude plugin validate . --strict PASS
claude --plugin-dir . 로드 PASS
/mcp proofgraph connected
/hooks guard/audit/stop 확인
20개 실제 과제 완료
허위 success terminal 0
검증 우회 0
승인 우회 0
금지 도구 실행 0
silent failure 0
모든 Run finalize 또는 abort
```
