# ProofGraph Standalone v5.0.0 실행 가이드

## 1. 시뮬레이션

```bash
proofgraph simulate --new "결제 API를 설계하라"
```

Reference Kernel만 사용한다. 실제 모델·도구를 호출하지 않으며 상태는 `simulation_complete`, Quality Gate는 false다.

## 2. Native Local Model

Ollama, vLLM, LM Studio 등 OpenAI-compatible endpoint를 사용한다.

```bash
proofgraph start \
  --provider-url http://127.0.0.1:11434/v1 \
  --provider-model qwen3-coder \
  --provider-name ollama \
  --native-local \
  --model-registry ./model-registry.json \
  --new "현재 프로젝트의 인증 기능을 구현하고 검증하라"
```

## 3. Native Cloud Model

원격 endpoint는 HTTPS만 허용한다.

```bash
export PROOFGRAPH_PROVIDER_API_KEY='...'
proofgraph start \
  --provider-url https://provider.example/v1 \
  --provider-model provider/model-version \
  --provider-key-env PROOFGRAPH_PROVIDER_API_KEY \
  --model-registry ./model-registry.json \
  --new "기능을 구현하고 독립 검증하라"
```

## 4. Sandbox Tool 실행

```bash
proofgraph start \
  --provider-url http://127.0.0.1:11434/v1 \
  --provider-model qwen3-coder \
  --native-local \
  --execute-tools \
  --source-dir "$PWD" \
  --new "테스트를 추가하고 실행하라"
```

기본 허용 명령은 `node`, `npm`, `npx`, `git`이다. Workspace 밖 경로, shell 문자열, 허용되지 않은 명령은 차단된다. 원본 프로젝트가 아니라 임시 복사본에서 실행한다.

## 5. Host Bridge

```bash
proofgraph start \
  --bridge-url http://127.0.0.1:8743 \
  --bridge-token "$PROOFGRAPH_HOST_BRIDGE_TOKEN" \
  --runtime-host opencode \
  --new "기능을 구현하고 검증하라"
```

## 최종 상태 판정

- `simulation_complete`: 모의 실행. 실제 결과가 아님.
- `completed_clean`: 실제 Host/Provider 실행 + 독립 증거 검증 통과.
- `completed_with_recovery`: 실패 후 Loop로 복구되어 검증 통과.
- `partial`, `failed`, `denied`, `aborted`: 완료 아님.
