# API Usage Guide

## 1) Resolve endpoint and keys

```bash
STACK_NAME=PrivateLiteLlmMicrovmStack
AWS_REGION=us-east-1

PUBLIC_API_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='PublicApiInvokeUrl'].OutputValue" --output text)

API_KEY_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AwsGatewayApiKeySecretArn'].OutputValue" --output text)

API_KEY_JSON=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" --secret-id "$API_KEY_SECRET_ARN" \
  --query SecretString --output text)

MASTER_KEY_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='LiteLlmMasterKeySecretArn'].OutputValue" --output text)

MASTER_JSON=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" --secret-id "$MASTER_KEY_SECRET_ARN" \
  --query SecretString --output text)

API_GATEWAY_KEY=$(python - <<'PY' "$API_KEY_JSON"
import json,sys
print(json.loads(sys.argv[1])["apiKey"])
PY
)

LITELLM_MASTER_KEY=$(python - <<'PY' "$MASTER_JSON"
import json,sys
v=json.loads(sys.argv[1])
print((v.get("prefix") or "") + (v.get("suffix") or ""))
PY
)
```

## 2) Health check

```bash
USER_KEY=$(cat infra/cdk/.keys/user-key.txt)
curl -sS "${PUBLIC_API_URL%/}/health/liveliness" \
  -H "x-api-key: $API_GATEWAY_KEY" \
  -H "Authorization: Bearer $USER_KEY"
```

## 3) Create a user key (recommended)

```bash
cd infra/cdk
PUBLIC_PLAN_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AwsGatewayUsagePlanId'].OutputValue" \
  --output text)

./scripts/create-api-key.sh \
  --usage-plan-id "$PUBLIC_PLAN_ID" \
  --alias app-user \
  --duration 7d

USER_KEY=$(cat .keys/app-user.txt)
```

Omit `--models` to create a key that can call all models. Add `--models ...` only when you want an explicit allowlist.

Manual `/key/generate` call (if needed):

```bash
curl -sS -X POST "${PUBLIC_API_URL%/}/key/generate" \
  -H "x-api-key: $API_GATEWAY_KEY" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  --data-raw '{"key_alias":"manual-user"}'
```

## 4) Chat completion

```bash
curl -sS -X POST "${PUBLIC_API_URL%/}/chat/completions" \
  -H "x-api-key: $API_GATEWAY_KEY" \
  -H "Authorization: Bearer $USER_KEY" \
  -H "Content-Type: application/json" \
  --data-raw '{
    "model": "nova-2-lite",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

## 5) Optional: test key with Strands

```bash
cd infra/cdk
./scripts/test-api-key-strands.sh --api-key "$USER_KEY" --api-url "$PUBLIC_API_URL"
```

## 6) IAM route usage (`/iam/...`)

After creating IAM mapping with `create-iam-key-mapping.sh`, call:

- `${PUBLIC_API_URL%/}/iam/chat/completions`

using SigV4 IAM auth.

## 7) Common failures

| Symptom | Typical cause |
|---|---|
| `403 Forbidden` from API Gateway | Wrong `x-api-key` |
| `401` from LiteLLM endpoints | Missing/invalid bearer key |
| `403` on `/iam/...` | IAM principal has no mapped LiteLLM key |
| `no healthy deployments` | Model/provider config not healthy or not loaded |
| `503 no_db_connection` | LiteLLM DB path unavailable |
| `Token authentication failed` | Stale proxy token vs replaced MicroVM (proxy cache mismatch) |
