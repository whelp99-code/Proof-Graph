# ProofGraph Standalone v5.0.0 릴리스 노트

## 추가
- Truthfulness Gate와 명시적 실행 모드
- OpenAI-compatible Native Model Gateway
- Native local/cloud 실행
- Sandbox Workspace 및 제한 Tool Runtime
- bounded Worker Runtime
- 실제 모델·Tool Receipt 기반 실행 보고서
- `proofgraph simulate`

## 보안
- 원격 Provider HTTPS 강제
- Workspace path escape 차단
- shell:false 및 command allowlist
- 증거 없는 Verifier 통과 차단
- Simulation Artifact 승격 차단

## 검증 상태
오프라인 fake-provider 및 REST/CLI/MCP/TUI 검증은 완료됐다. 실제 사용자 Provider 자격증명과 OpenCode 등 외부 Host의 인증 canary는 별도 수행해야 한다.
