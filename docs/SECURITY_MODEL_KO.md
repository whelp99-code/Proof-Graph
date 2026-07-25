# ProofGraph v1.0 보안 모델

## 불변조건

1. 성공 경로는 verifier를 우회할 수 없다.
2. 고위험·비가역 경로는 approval node를 거쳐야 한다.
3. 실패·차단·누락은 원장에서 삭제하지 않는다.
4. 외부 Adapter는 기본 비활성이다.
5. subprocess는 shell 문자열이 아니라 argv로 실행한다.
6. Workspace action은 challenge와 digest가 일치한 승인 후에만 실행한다.
7. 절대 경로, traversal, `.git`, symlink escape를 차단한다.
8. Graph·event·report·debugger·workspace 상태를 digest로 검사한다.
9. Inspector는 기본 loopback + token이다.
10. unknown MCP tool·unknown field·prototype key·과대 입력은 fail-closed다.

## 잔여 위험

- 역할과 사람 신원은 기본적으로 자기신고이며 암호학적 신원이 아니다.
- Git worktree는 네트워크와 커널을 격리하지 않는다.
- 실제 공급자 CLI의 권한 모델과 출력 형식은 버전에 따라 달라질 수 있다.
- heuristic risk/complexity는 라우팅 입력이지 객관적 사실이 아니다.

운영 시 container/VM, 최소권한 계정, secret broker, branch protection, 필수 리뷰, 공급자별 canary를 추가해야 한다.
