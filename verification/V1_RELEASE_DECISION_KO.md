# ProofGraph v1.0.0 출시 판정

## 판정: PASS_OFFLINE_VENDOR_CANARY_REQUIRED

### 허용

- Graph Compiler·Runtime·Template 개발 및 로컬 사용
- Mock Adapter 기반 재현 시험
- 읽기 전용 코드·리서치·설계 작업
- 승인 기반 disposable Git worktree에서의 제한된 action 실행
- CLI·ESM·범용 MCP·Claude Plugin의 개발/Canary 사용
- Debugger·Inspector·무결성·감사 보고서 사용

### 조건부 허용

- Claude, Codex, OpenCode, Grok, Pi: 설치 버전 고정 + 인증 + live canary + 권한 검토 후
- GJC: pinned SDK v3 WebSocket bridge 또는 명시적 trusted command profile + live canary 후
- Workspace 명령 실행: 신뢰된 repository와 allowlist, 필요 시 외부 container/VM 안에서

### 금지

- 외부 공급자 canary 없이 production-ready 표시
- 무인 프로덕션 배포·DB 변경·결제·게시
- Git worktree를 네트워크 또는 커널 sandbox라고 주장
- 로컬 SHA-256을 전자서명·공증으로 표현
- 논리적 Agent 역할을 독립된 실제 신원으로 표현

### 다음 운영 게이트

1. `claude plugin validate . --strict`
2. 공급자별 설치 버전·인증 방식 기록
3. 공급자별 최소 20건 canary
4. 금지 mutation 0건, silent failure 0건
5. timeout·취소·malformed output 시험
6. 필요 시 container/VM sandbox 추가
7. canary 결과를 버전별 인증 매트릭스에 고정
