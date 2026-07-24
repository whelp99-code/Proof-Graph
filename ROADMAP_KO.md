# ProofGraph 전체 로드맵

## 비전

ProofGraph는 여러 AI 에이전트가 만든 주장·근거·검증·결정을 재현 가능한 실행 원장으로 관리하는 **증거 중심 Agent Control Plane**을 목표로 합니다.

현재 1차 제품은 Claude Code 전용 읽기 전용 리서치 플러그인입니다. 장기적으로는 Claude에서 검증된 통제 모델을 바탕으로 다른 에이전트와 Provider까지 확장합니다.

## 제품 원칙

1. **No silent failure** — 실패·차단·누락 작업을 삭제하지 않습니다.
2. **No unverified promotion** — 검증되지 않은 주장을 확정 결과로 승격하지 않습니다.
3. **Fail closed** — 상태·권한·무결성을 확인하지 못하면 실행을 거부합니다.
4. **Deterministic control plane** — 예산·권한·전이·승인은 코드가 통제합니다.
5. **Evidence before consensus** — 에이전트 다수결보다 원문·테스트·재현 증거를 우선합니다.
6. **Measured scaling** — 에이전트 수는 품질 향상이 측정될 때만 증가시킵니다.

---

## Phase 0 — 연구 및 로컬 실행 커널

**상태: 완료**

- 타입이 있는 DAG 실행기
- 병렬 map/fan-in
- 체크포인트·재개·캐시
- 구조화 출력
- 주장·근거 원장
- Mock 기반 1,000 논리 작업 부하 시험
- 독립·적대적 검증 기반 마련

이 단계에서 발견된 예산 하드리밋, 캐시 오염, 실패 재개, 가짜 근거 승격 문제는 Claude 전용 MVP 설계에 반영했습니다.

---

## Phase 1 — Claude Code 전용 MVP

**버전: v0.2.x**  
**현재 상태: 오프라인 검증 완료, 실제 Claude canary 필요**

### 구현 완료

- Claude Code 플러그인 배포 구조
- planner / researcher / verifier / synthesizer Subagent
- 로컬 stdio MCP 서버
- PreToolUse·Stop·감사 Hook
- 읽기 전용 도구 정책
- SSRF 차단 및 안전한 HTTPS 수집
- exact quote 검사
- 역할별 mutation 권한
- 하드 호출·출처·Agent·벽시계 예산
- 주장·근거·판정 원장
- 이벤트 hash chain과 파일 무결성 검사
- 자동·통합·적대적·독립 블랙박스 검증

### v0.2.1 — 실제 Claude Canary

목표:

- 실제 Claude Code에서 최소 20건 실행
- X 게시물, 공식 문서, 기술 주장, 저장소 분석을 포함한 골드셋 구축
- 허위 `supported` 0건
- 금지 도구 실행 0건
- 모든 Run이 `finalize` 또는 `abort`로 종료
- 출처–인용 정확도 100%
- 비용·지연·실패 유형 측정

출시 게이트:

- `claude plugin validate . --strict` 통과
- Linux/macOS 실제 설치 시험
- Claude Code Hook/MCP/Subagent lifecycle 확인
- canary 결과와 원시 검증 로그 공개

### v0.2.2 — 운영 강화

- 중단된 Run 복구 UX
- 정책 파일 외부화
- 출처 도메인 신뢰 등급
- 의미적 지지 여부를 위한 교차 검증 강화
- 테스트 fixture와 production 경계 강화
- GitHub Actions, CodeQL, Dependabot
- signed release artifact 및 SBOM

### v0.2.3 — 리서치 템플릿 확장

- 기술 주장 검증
- 공식 문서 비교
- 오픈소스 프로젝트 감사
- 제품·서비스 비교
- 논문·벤치마크 검증
- PRD·SPEC 근거 조사

---

## Phase 2 — Claude Agent Runtime

**목표 버전: v0.3.x**

Claude Code 플러그인을 넘어 Claude 기반 에이전트 실행을 공통 런타임으로 관리합니다.

### 핵심 범위

- Agent Manifest 및 Agent Registry
- 노드별 역할·모델·도구·예산 정의
- Delegation Token과 권한 감쇠
- Tool Broker 및 Human Approval Gate
- SQLite Event Store
- REST/SSE 기반 로컬 Control Plane
- pause / resume / cancel / retry
- OpenTelemetry 호환 trace
- 프로젝트·실행별 아티팩트 저장소

### 완료 기준

- 등록되지 않은 Agent 실행 차단
- 모든 모델·도구 호출에 Run ID와 Agent ID 부여
- 자식 Agent 권한이 부모 권한을 초과하지 않음
- 위험 도구는 승인 전 실행되지 않음
- Control Plane 재시작 후 상태 복구
- 한 실행을 trace와 원장으로 재구성 가능

---

## Phase 3 — Operator Console

**목표 버전: v0.4.x**

TUI는 실행 엔진이 아니라 Control Plane의 운영 콘솔로 제공합니다.

### 최소 TUI

- Runs 대시보드
- Workflow graph
- Agent/Node inspector
- Live event stream
- Approval queue
- Evidence ledger
- Budget·cost·latency 화면
- 실패 node 재시도 및 Run 취소

### 원칙

- TUI가 상태 파일이나 DB를 직접 수정하지 않음
- 모든 명령은 Control Plane API를 통함
- TUI를 종료해도 Workflow는 계속 실행됨

---

## Phase 4 — Multi-provider 확장

**목표 버전: v0.5.x**

Claude에서 검증된 정책·증거 모델을 다른 실행 환경으로 확장합니다.

### Adapter

- Claude Agent SDK
- OpenAI Agents SDK
- Generic OpenAI-compatible HTTP
- Local model
- CLI/Subprocess Agent
- MCP client/server adapter

### 통제 등급

- L0 Unmanaged
- L1 Observed
- L2 Governed
- L3 Controlled
- L4 Verifiable

L0/L1 결과는 자동으로 확정 결과에 승격하지 않습니다.

---

## Phase 5 — Durable Distributed Runtime

**목표 버전: v0.6.x**

- Temporal 또는 동등한 Durable Execution backend
- PostgreSQL RunStore
- Object Storage
- 원격 Worker와 Queue routing
- 멱등성 키와 중복 억제
- 장애 주입 및 복구 시험
- 100 → 250 → 500 → 1,000 논리 작업 확장 시험

`1,000개`는 누적 작업·실행 중 작업·동시 모델 요청을 구분하여 표기합니다.

---

## Phase 6 — AI Council OS 통합

**목표 버전: v1.0**

ProofGraph를 AI Council OS의 실행·검증 계층으로 통합합니다.

### 최종 흐름

```text
사용자 목표
  → Multi-AI / Multi-Agent 토론
  → 주장·충돌 그래프
  → 독립 검증과 unresolved 유지
  → 사람 승인
  → 합의된 Decision Graph
  → PRD / SPEC / Issue / Marketing Artifact
  → 실행 도구 및 외부 시스템
```

### v1.0 완료 기준

- 토론 과정과 입장 변화 추적
- 합의와 미해결 쟁점 분리
- 주장 단위 provenance
- 사람 승인 게이트
- 산출물의 근거 역추적
- GitHub/Jira/문서 시스템 연동
- 팀·권한·감사 로그
- 비용과 품질 점수표

---

## 공통 검증 트랙

모든 단계에서 다음 검증을 유지합니다.

- 단위·통합 시험
- 적대적 시험
- 블랙박스 독립 검증
- 실제 Provider canary
- 오류 주입
- 기준선 대비 품질·비용 비교
- 공개된 실패와 제한 사항
- 재현 가능한 release manifest

## 현재 우선순위

1. GitHub Actions 자동 검증
2. 실제 Claude CLI strict validation
3. 20건 Claude canary
4. canary 결함 수정 및 v0.2.1
5. signed v0.2.1 Release
6. Agent Registry·Tool Broker 설계 착수

## 상태 표기

- **Implemented**: 코드가 존재함
- **Offline verified**: 모의·정적·블랙박스 검증 통과
- **Provider verified**: 실제 Claude/API에서 통과
- **Operationally verified**: 반복 운영과 장애 주입 통과
- **Released**: tag, release artifact, checksum, changelog 공개

현재 ProofGraph Claude MVP는 **Implemented + Offline verified** 단계입니다.