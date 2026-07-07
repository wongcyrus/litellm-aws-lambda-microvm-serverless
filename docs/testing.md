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

## IAM Strands baseline

- `infra/cdk/scripts/test-iam-strands.sh`
- `infra/cdk/scripts/test-iam-strands.py`

## Important auth note

For raw API tests, use correct header split:

- `x-api-key` = API Gateway key from `AwsGatewayApiKeySecretArn`
- `Authorization` = Bearer user key from LiteLLM key generation
