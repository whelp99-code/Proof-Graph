# ProofGraph v1.1.0 알려진 제한

## 완료된 검증 (v1.1.0)

- **OpenCode Host Bridge live canary**: 완료 (2026-07-25)
  - Bridge 서버 (`host serve opencode`) 정상 동작 확인
  - `/v1/health`: protocol_version `proofgraph.host.v1`, capabilities 9개 응답
  - `/v1/capabilities`: opencode/pi/orca/custom 4개 host capabilities 응답
  - `/v1/events` SSE: `bridge.connected` 이벤트 정상 수신
  - `/v1/tool-policy`: read-only tool → `allow`, mutation tool (run 없음) → `deny`
  - `/v1/commands` compile: GraphSpec 컴파일 정상 (objective → assessment + graph)
  - 보안 경계: `approve`/`deny`/`abort` 명령 → 403 (operator path only)
  - Host identity mismatch: `pi` 요청을 `opencode` bridge에 전송 → 403
  - 무단 접근: 토큰 없이 `/v1/capabilities` → 401 `unauthorized`
  - OpenCode plugin 모듈 로드: hooks 5개 등록 (`tool`, `event`, `tool.execute.before`, `tool.execute.after`, `shell.env`)
  - bridge-client 모듈 로드: `createBridgeClient`, `bridgeConfigFromEnv`, `likelyMutation`, `likelyExternalSideEffect` export 확인
  - OpenCode 버전: 1.18.0 (contract target 1.18.4와 minor 차이, 호환)

## 남은 제한

- Pi host live canary: 미완료 (Pi 0.82.0 미설치 환경)
- 실제 Claude/Codex/GJC/Grok 공급자 인증 호출은 이 빌드 환경에서 수행하지 않았다.
- 공급자별 structured output envelope은 버전 변화에 따라 Adapter 수정이 필요할 수 있다.
- Codex JSON 플래그와 event envelope은 설치 버전에 따라 달라질 수 있으므로 `adapters.codex.output_args`와 live canary가 필요하다.
- GJC 기본 통합은 SDK v3 WebSocket bridge 구현체를 번들하지 않으며, pinned bridge 또는 명시적 command profile이 필요하다.
- Git worktree는 네트워크·커널 sandbox가 아니다.
- 승인 challenge는 승인자의 실제 인간 신원을 암호학적으로 증명하지 않는다.
- Agent 역할은 기본적으로 논리적 신원이다.
- heuristic complexity/risk 값은 라우팅 입력이지 객관적 측정치가 아니다.
- 범용 MCP의 `run`은 동기 요청이므로 매우 긴 작업은 host timeout 정책과 조정해야 한다.
- 분산 worker, durable queue, 조직 RBAC, signed graph registry는 v1.1.0 범위 밖이다.
- npm registry에 게시된 패키지가 아니라 소스 릴리스다.

릴리스 게이트는 `PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED`이다. OpenCode canary는 완료, Pi canary는 미완료 상태이다.
