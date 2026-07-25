# ProofGraph 제품 로드맵

ProofGraph는 AI Council OS가 아니라 **Graph Engineering 기반 AI 개발 도구**입니다. 기존 AI 코딩 도구의 UI와 모델을 대체하지 않고, 작업을 타입 그래프로 컴파일하고 실행·검증·재라우팅하는 Runtime을 제공합니다.

## 완료

### v0.6 — Universal Runtime Kernel

- 타입이 있는 AgentRequest/AgentResult
- Adapter 독립 커널
- 조건 라우팅과 Failure Packet
- checkpoint/resume와 event integrity

### v0.7 — Universal Adapter Layer

- Claude, Codex, OpenCode, Grok, Pi, GJC 확장 경계
- shell 없는 argv subprocess 실행
- timeout, cancel, 출력 상한, Adapter doctor

### v0.8 — Workspace Execution Engine

- disposable detached Git worktree
- typed write/delete/patch/command action
- challenge 기반 사람 승인
- diff, receipt, rollback, 직접 변조 탐지

### v0.9 — Graph Debugger + Inspector

- pause/resume/single-step
- node/kind breakpoint
- event·route·failure·integrity 조회
- text, JSON, DOT, loopback HTTP

### v1.0 — Graph Engineering Platform

- CLI·MCP·Adapter·Workspace·Debugger 공통 Platform Factory
- 개발 업무용 Graph Template Registry
- 프로젝트 초기화·설정
- 범용 stdio MCP와 ESM API
- Claude Code 플러그인 유지

### v1.1 — OpenCode·Pi First-class Hosts

- **OpenCode 1차 기준 Host**: local Plugin, Server/SSE Worker, tool/permission bridge, diff artifact
- **Pi 2차 Reference TUI Host**: TypeScript Extension, strict JSONL RPC Worker, session persistence, approval UI
- `proofgraph.host.v1` UI 중립 Host Protocol
- bearer-auth loopback HTTP/SSE Bridge
- 프로젝트·사용자 범위 관리형 설치
- Host tool policy fail-closed
- Mock E2E, 적대적 시험, 독립 블랙박스 검증
- 상태: `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`

## 다음 게이트

### v1.1.x — 실제 Host 인증

- OpenCode·Pi 버전 고정
- 실제 로그인·Server/RPC 연결
- Host별 대표 Graph 20건 canary
- 승인·tool-policy·abort·resume·diff/session persistence 검증
- 지연·비용·실패율 측정

### v1.2 — Task Intelligence Compiler

- Workspace Discovery 선행
- TaskSpec과 작업 유형 분류
- 검증된 Graph Blueprint
- Graph Adequacy Validator
- 한국어·영어 Compiler 평가 세트

### v1.3 — Strong Sandbox

- Container/VM Workspace backend
- 네트워크 정책과 secret broker
- CPU·메모리·시간·syscall 제한
- 승인된 patch/test/rollback 실행

### v1.4 — Graph Package Registry

- 서명된 Graph package
- 버전·호환성·조직 정책 pack
- 재현 가능한 benchmark fixture

### v1.5 — Durable Distributed Execution

- 원격 Worker와 내구성 queue
- lease·멱등 재시도·장애 복구
- 여러 프로젝트와 Host의 통합 운영

모든 기능은 구현만으로 완료 처리하지 않습니다. 적대적 테스트, 독립 재현, 필요한 실제 Host·공급자 canary까지 통과해야 production-ready로 승격합니다.
