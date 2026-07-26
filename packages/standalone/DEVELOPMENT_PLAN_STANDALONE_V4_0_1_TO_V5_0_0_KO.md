# ProofGraph Standalone v4.0.1 → v5.0.0 단계별 개발 계획 및 완료 기록

## 목표

ProofGraph를 상태·TUI 시뮬레이터에서 실제 모델·Host·Sandbox를 선택해 업무를 수행하는 독립 실행형 AI 조직 Runtime으로 전환한다. `실제 실행`과 `시뮬레이션`을 절대로 혼동하지 않는다.

## 불변조건

1. 시뮬레이션은 `COMPLETED CLEAN`, Verified Artifact, 외부 Delivery로 승격될 수 없다.
2. 실제 모델 ID, Provider Request ID, Token, Tool Receipt가 실행 증거에 포함된다.
3. Verifier는 증거가 없으면 실패한다.
4. 파일·명령 실행은 Disposable Workspace와 allowlist를 통과한다.
5. 모델은 승인·거절·중단·정책 변경 권한을 갖지 않는다.
6. 모든 Queue 작업은 중복 방지와 bounded concurrency를 갖는다.

## 단계별 구현

### v4.0.1 Truthfulness Gate — 완료
- `simulation`, `hosted`, `native_cloud`, `native_local` 실행 모드
- Reference Kernel 결과 `simulation_complete`
- Simulation Artifact 승격 및 Quality Gate 차단
- TUI/Projection에 실행 모드 표시

### v4.1.0 Host Contract — 완료(계약), 실 Host canary 필요
- 기존 `proofgraph.host.v1` 유지
- Host 실행 보고서와 무결성 조회
- Operator 전용 명령 차단

### v4.2.0 OpenCode/Host Execution — 완료(Bridge), 인증 canary 필요
- `--bridge-url`, `--bridge-token`, `--runtime-host`
- 실제 Host Report를 Mission 상태에 결합

### v4.3.0 Native Model Gateway — 완료
- OpenAI-compatible `/chat/completions` Adapter
- Cloud HTTPS 강제, Loopback HTTP 허용
- Structured JSON output, timeout, model/request/usage 증거
- `native_cloud`, `native_local` 모드

### v4.4.0 Sandboxed Tool Runtime — 완료
- 임시 Workspace
- 경로 이탈 차단
- Command allowlist
- shell:false
- 실행 시간·출력 크기 제한
- 파일 digest와 command receipt

### v4.5.0 Collaboration Worker Runtime — 완료
- bounded concurrency
- duplicate task 차단
- queue/active/completed 상태
- 비동기 결과 회수

### v4.6.0 Evidence Gate — 완료
- Verifier는 independent=true와 evidence를 동시에 요구
- command failure 시 Artifact 승격 차단
- 실제 모델·도구 실행 정보 보고서 결합

### v4.7.0 Knowledge/Memory — 기존 v4 기능 유지
- Hash-chain Memory
- provenance·검증·supersession
- Knowledge impact graph

### v4.8.0 Measured Routing — 구조 완료, 실제 benchmark data 필요
- exact model routing 및 observation
- 정책 자동 변경 금지
- live canary 후 registry 승인 절차

### v4.9.0 Durable Control Plane — 로컬 단일 노드 완료
- Hash-chain command store
- durable queue·lease·heartbeat
- 다중 사용자 PostgreSQL/OIDC는 후속 운영 확장

### v5.0.0 Standalone GA Candidate — 오프라인 완료
- `proofgraph simulate`
- `proofgraph start --provider-url ... --provider-model ...`
- Host Bridge와 Native Provider 선택
- Operator TUI와 실시간 상태
- 재현 패키지·독립 fake-provider black-box 검증

## 완료 판정

- 코드·오프라인 독립 검증: 완료
- 실제 외부 Provider 자격증명 canary: 필요
- 실제 OpenCode/Pi/Claude/Orca canary: 필요
- 팀·분산·고가용성 운영: v5.x Enterprise 트랙
