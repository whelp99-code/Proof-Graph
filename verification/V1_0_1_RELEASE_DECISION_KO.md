# ProofGraph v1.0.1 출시 판정

## 판정: PASS_OFFLINE_VENDOR_CANARY_REQUIRED

### 허용

- `AI에인전트 TUI를 개발하라` 같은 자연어의 `agent-tui` GraphSpec 컴파일
- 명시적 GraphSpec의 검토·버전 관리·CLI/MCP 실행
- Mock Adapter 기반 조건부 라우팅·승인·검증 루프 시험
- 로컬 단일 운영자 `proofgraph tui`와 snapshot 사용
- 읽기 전용 분석, 설계, 구현 artifact 생성, 독립 검증

### 조건부 허용

- Claude, Codex, OpenCode, Grok, Pi: 버전 고정·인증·live canary·권한 검토 후
- GJC: 신뢰된 SDK v3 WebSocket bridge 또는 명시적 command profile과 canary 후
- Workspace mutation: 승인된 action digest, 신뢰 저장소, allowlist, 필요 시 외부 container/VM 안에서

### 금지

- Mock 결과를 실제 공급자 코드 품질로 표현
- 공급자 canary 없이 production-ready 표시
- 승인 이중 키를 암호학적 사람 신원 증명으로 표현
- 로컬 TUI를 원격 다중 사용자 Control Plane으로 표현
- 무인 프로덕션 배포·DB 변경·결제·게시

### 다음 게이트

1. `claude plugin validate . --strict`
2. Claude/Codex/OpenCode/GJC/Grok/Pi 버전별 live canary
3. 성공·실패·취소·malformed output·timeout 시나리오
4. 금지 mutation 0건, silent failure 0건
5. 공급자별 인증 매트릭스와 운영 승인
