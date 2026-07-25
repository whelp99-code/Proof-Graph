# ProofGraph v1.0 알려진 제한

- 실제 Claude/Codex/OpenCode/GJC/Grok/Pi 인증 호출은 이 빌드 환경에서 수행하지 않았다.
- 공급자별 structured output envelope은 버전 변화에 따라 Adapter 수정이 필요할 수 있다.
- Codex JSON 플래그와 event envelope은 설치 버전에 따라 달라질 수 있으므로 `adapters.codex.output_args`와 live canary가 필요하다.
- GJC 기본 통합은 SDK v3 WebSocket bridge 구현체를 번들하지 않으며, pinned bridge 또는 명시적 command profile이 필요하다.
- Git worktree는 네트워크·커널 sandbox가 아니다.
- 승인 challenge는 승인자의 실제 인간 신원을 암호학적으로 증명하지 않는다.
- Agent 역할은 기본적으로 논리적 신원이다.
- heuristic complexity/risk 값은 라우팅 입력이지 객관적 측정치가 아니다.
- 범용 MCP의 `run`은 동기 요청이므로 매우 긴 작업은 host timeout 정책과 조정해야 한다.
- 분산 worker, durable queue, 조직 RBAC, signed graph registry는 v1.0 범위 밖이다.
- npm registry에 게시된 패키지가 아니라 소스 릴리스다.

릴리스 게이트는 `PASS_OFFLINE_VENDOR_CANARY_REQUIRED`이다. 공급자별 canary 전에는 해당 Adapter를 production-ready로 표시하지 않는다.
