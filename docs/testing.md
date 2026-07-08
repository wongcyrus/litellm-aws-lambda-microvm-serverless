# Testing Guide

## Provider test runners

Scripts:

- `infra/cdk/scripts/test-aws-strands.sh`
- `infra/cdk/scripts/test-gcp-strands.sh`
- `infra/cdk/scripts/test-azure-strands.sh`

Each runner sends `hi` across all models in that provider group and fails fast on first error.

Run:

```bash
cd infra/cdk
./scripts/test-aws-strands.sh
./scripts/test-gcp-strands.sh
./scripts/test-azure-strands.sh
```

Optional overrides:

```bash
PROMPT="hi" MAX_TOKENS=64 TEMPERATURE=0.0 ./scripts/test-aws-strands.sh --api-key-file .keys/user-key.txt
```

## API-key Strands baseline

- `infra/cdk/scripts/test-api-key-strands.sh`
- `infra/cdk/scripts/test-api-key-strands.py`

`test-api-key-strands.py` validates API-key flow end-to-end:

1. `x-api-key` passes API Gateway usage-plan check.
2. `Authorization` bearer key passes LiteLLM auth.
3. Chat completion returns a valid model response.

Wrapper behavior in `test-api-key-strands.sh`:

- creates/reuses virtualenv
- installs Strands dependencies
- resolves `PublicApiInvokeUrl` automatically if not provided

## IAM Strands baseline

- `infra/cdk/scripts/test-iam-strands.sh`
- `infra/cdk/scripts/test-iam-strands.py`

`test-iam-strands.py` validates `/iam/...` path:

1. assumes IAM role
2. signs request with SigV4 (`execute-api`)
3. calls OpenAI-compatible `/iam/chat/completions`

Wrapper behavior in `test-iam-strands.sh`:

- creates/reuses virtualenv
- installs dependencies
- resolves API URL and role ARN from outputs by default

## Provider model coverage

### `test-aws-strands.sh`

- `nova-2-lite`
- `minimax-m2.5`
- `kimi-k2.5`

### `test-gcp-strands.sh`

- `gemini-3.5-flash`
- `gemini-3.1-flash-lite`
- `gemini-3.1-flash-image-preview`
- `gemini-3.1-pro-preview`
- `gemini-3.1-pro-preview-customtools`
- `gemini-2.5-pro`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`

### `test-azure-strands.sh`

- `gpt-5.2`
- `gpt-5.4-mini`
- `gpt-5.4-nano`
- `gpt-5.4`

## Important auth note

For raw API tests, use correct header split:

- `x-api-key` = API Gateway key from `AwsGatewayApiKeySecretArn`
- `Authorization` = Bearer user key from LiteLLM key generation
