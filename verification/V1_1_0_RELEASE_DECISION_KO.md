# ProofGraph v1.1.0 출시 판정

## 판정

```text
PASS_OFFLINE_OPENCODE_PI_CANARY_REQUIRED
```

## 허용

- OpenCode·Pi 통합 소스 공개
- Mock 및 fake endpoint 기반 개발·계약 시험
- 프로젝트 단위 Plugin/Extension 설치 시험
- 실제 Host를 사용한 제한된 로컬 canary 착수
- 사람이 결과를 검토하는 개발 보조

## 아직 허용하지 않음

- 조직 전체 기본 활성화
- 사람 검토 없는 코드 변경·merge·배포
- 원격 공개 Host Bridge
- 실제 비용 hard cap이 입증되지 않은 장시간 무인 실행
- live canary 없이 특정 OpenCode/Pi 버전을 production-ready로 선언

## 승격 조건

OpenCode와 Pi 각각 최소 20건의 실제 canary를 완료하고, 승인·도구 정책·재개·중단·출력 계약·Host 재시작 복구를 확인한 뒤 v1.1.x certification release로 승격합니다.

## 검토 계약 대상

```text
OpenCode CLI/server  1.18.4
@opencode-ai/plugin  1.18.4
Pi CLI               0.82.0
Pi Node.js           22.19.0 이상
```

이는 오프라인 소스·프로토콜 검토 대상이며 production 인증이 아닙니다. 설치된 바이너리는 정확 버전 preflight와 인증된 live canary를 모두 통과해야 합니다.
