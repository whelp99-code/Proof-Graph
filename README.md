# ProofGraph Claude MVP v0.2.0

Claude Code 전용 **읽기 전용·증거 게이트형 딥리서치 플러그인**입니다.

- 배포 단위: Claude Code 플러그인
- 결정론적 상태·증거 엔진: 플러그인 내장 stdio MCP 서버
- 실행 경계: `PreToolUse`, `Stop`, 감사 Hook
- 역할: planner → primary/secondary researcher → verifier → synthesizer
- 런타임 의존성: Node.js 20 이상, 외부 npm 패키지 없음

전체 설치·사용법은 [README_KO.md](./README_KO.md)를 참고하십시오.
