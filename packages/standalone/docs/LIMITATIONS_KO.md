# ProofGraph Intelligence v4.0.0 알려진 제한

1. 공개 ProofGraph v1.1.0 exact tree와 현재 v4 상위 패키지의 최종 통합 회귀가 남아 있다.
2. 이 검증 환경에서는 인증된 OpenCode·Pi·Claude·Orca의 실제 다중 모델 canary를 수행하지 않았다.
3. `examples/model-registry.example.json`의 ID와 품질·비용·latency 값은 구성 형식 예시다. 실제 공급자 성능 주장이나 추천값이 아니다.
4. Model Router는 registry 입력을 결정론적으로 평가한다. 실제 운영 telemetry를 자동 학습해 registry를 변경하지 않는다.
5. ModelObservation은 성공·실패·지연·토큰·비용을 기록하지만 Registry를 자동 변경하지 않는다. 동적 health feedback은 별도 평가·승인·Registry 버전 갱신으로 운영해야 한다.
6. Context redaction은 secret-like 키와 알려진 문자열 패턴을 방어하지만 모든 개인정보·영업비밀을 완벽히 분류하는 DLP를 대신하지 않는다.
7. Context source digest와 freshness는 로컬 무결성·노후도 신호이며 외부 전자서명·공증 또는 원문의 의미적 진실성 보증이 아니다.
8. Knowledge Graph는 bounded local property graph다. 대규모 분산 Graph DB나 완전한 의미 추론 엔진이 아니다.
9. Impact Analysis는 명시적 관계와 보고서 데이터를 기반으로 검토 범위를 계산한다. 숨은 런타임 의존성을 완전하게 자동 발견한다고 주장하지 않는다.
10. Organization Memory 검색은 lexical token, tag, graph neighborhood와 confidence를 사용한다. vector embedding이나 외부 Knowledge DB는 포함하지 않는다.
11. 검증되지 않은 Memory는 기본 recall에서 제외하지만, 잘못 검증된 출처의 의미적 진실성을 시스템이 절대적으로 보증하지 않는다.
12. WorkContract는 전달·책임·acceptance 상태를 추적하지만 Agent의 실제 의도를 암호학적으로 증명하지 않는다.
13. Control Plane은 로컬 단일 운영자를 기본으로 하며 팀 RBAC·OIDC·mTLS를 제공하지 않는다.
14. 상태 저장은 파일 기반 HashChainStore다. PostgreSQL·Temporal·Raft 수준 고가용성이나 분산 합의를 주장하지 않는다.
15. OpenCode Observer는 관측 계층이며 Host event 자체가 실제 행위의 cryptographic attestation은 아니다.
16. OpenCode 작업 완료와 ProofGraph 검증 완료는 별개다.
17. Approval challenge는 로컬 실행 연속성을 확인하지만 법적 신원 인증을 대신하지 않는다.
18. TUI는 터미널 문자 기반이며 웹 UI가 아니다.
19. Windows native terminal은 정식 검증 범위가 아니며 WSL을 권장한다.
20. `completed_clean` 또는 quality gate PASS도 결과의 절대적 진실성을 의미하지 않는다. 중요한 변경에는 실제 테스트·공식 문서·사람 검토가 필요하다.
