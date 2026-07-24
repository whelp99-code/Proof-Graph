# ProofGraph Claude MVP v0.2.0

Claude Code 전용 **읽기 전용·증거 게이트형 딥리서치 플러그인**입니다.

- 배포 단위: Claude Code 플러그인
- 결정론적 상태·증거 엔진: 플러그인 내장 stdio MCP 서버
- 실행 경계: `PreToolUse`, `Stop`, 감사 Hook
- 역할: planner → primary/secondary researcher → verifier → synthesizer
- 런타임 의존성: Node.js 20 이상, 외부 npm 패키지 없음

## Project status

- Current release line: `v0.2.x`
- Status: **Implemented + Offline verified**
- Next gate: real Claude Code strict validation and a 20-case canary
- Long-term direction: Claude Agent Runtime → Operator TUI → Multi-provider Control Plane → AI Council OS

## Documentation

- [한국어 설치·사용 가이드](./README_KO.md)
- [Full roadmap](./ROADMAP.md)
- [전체 로드맵 한국어](./ROADMAP_KO.md)
- [Architecture](./docs/ARCHITECTURE_KO.md)
- [Security model](./docs/SECURITY_MODEL_KO.md)
- [Known limitations](./docs/LIMITATIONS_KO.md)

## Validation

GitHub Actions executes the full automated, preflight, adversarial, independent black-box, package, and release-manifest checks on pushes and pull requests.

Actual Claude-host validation remains a separate release gate because CI does not contain an authenticated Claude Code session.