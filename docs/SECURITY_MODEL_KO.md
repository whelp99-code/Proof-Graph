# 보안 모델

## 보호 목표

- 출처에 포함된 지시가 Claude의 실행 지시로 승격되는 것을 방지
- 사설망·localhost·메타데이터 엔드포인트로의 SSRF 차단
- 조작 인용·임의 source ID·보고서 분류 주입 차단
- 다른 MCP·Shell·파일 쓰기·다른 Skill을 통한 우회 차단
- 실패·예산 초과·미완료 상태의 은폐 차단
- 저장 출처·이벤트·보고서 변경 탐지

## 신뢰 경계

### 신뢰함

- 로컬 Node.js 런타임과 운영체제 사용자 계정
- 설치된 플러그인 코드가 최초 배포 manifest와 일치함
- Claude Code가 문서화된 Hook·MCP 호출 계약을 준수함

### 신뢰하지 않음

- 웹 문서와 그 안의 모든 자연어 지시
- Claude가 생성한 URL·인용문·분류·actor 문자열
- 검색 snippet
- 다른 MCP 서버와 다른 Skill
- 저장 파일이 이후 수정되지 않았다는 가정

## 주요 통제

### 네트워크

HTTPS 443만 허용한다. 호스트 문법과 허용 도메인을 검사하고 DNS의 모든 A/AAAA 응답을 검증한다. 연결은 검증된 주소로 수행하며 각 리디렉션에서 다시 URL·DNS 검사를 거친다.

### 도구

활성 Run 동안 PreToolUse Hook이 허용 목록을 적용한다. 상태를 읽을 수 없으면 차단한다.

### 역할

서버는 planner, research-primary, research-secondary, verifier, synthesizer, coordinator의 허용 작업을 구분한다. coordinator는 성공을 대신 기록할 수 없고 실패·차단만 기록할 수 있다.

### 무결성

- 이벤트별 이전 hash 연결
- 상태 digest를 `state.committed` 이벤트에 기록
- 출처 파일 SHA-256
- 인용문 exact-match 및 hash
- 보고서 JSON·Markdown hash
- finalize 직전 전체 출처·증거 재검사

## 비보장 사항

- actor 이름은 암호학적 신원이 아니다. 같은 Claude 호스트가 `verifier` 역할을 선언할 수 있다.
- hostname이 다르다고 실제 법적·편집적 독립 출처인 것은 아니다.
- 정확 일치 인용은 해당 문자열이 저장 원문에 존재함을 증명할 뿐, 그 문장이 주장을 논리적으로 지지하거나 맥락상 올바르게 해석됐음을 보증하지 않는다.
- 로컬 hash 체인은 신뢰된 외부 timestamp·서명·공증이 아니다.
- Plugin Hook이 Claude Code 자체의 결함이나 운영체제 계정 탈취를 방어하지는 않는다.
- 모델 토큰·청구액은 직접 하드 제한하지 않는다.
- `supported`는 설정된 증거 규칙 충족을 의미하며 사실의 절대적 보증이 아니다.
