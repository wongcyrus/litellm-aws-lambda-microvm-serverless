# API Usage Guide

## Resolve endpoint and gateway key

```bash
STACK_NAME=PrivateLiteLlmMicrovmStack
AWS_REGION=us-east-1

PUBLIC_API_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='PublicApiInvokeUrl'].OutputValue" --output text)

API_KEY_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='AwsGatewayApiKeySecretArn'].OutputValue" --output text)

API_GATEWAY_KEY=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$API_KEY_SECRET_ARN" --query SecretString --output text | python -c 'import json,sys; print(json.load(sys.stdin)["apiKey"])')
```

## Health check

```bash
USER_KEY=$(cat infra/cdk/.keys/user-key.txt)
curl -sS "${PUBLIC_API_URL%/}/health/liveliness" \
  -H "x-api-key: $API_GATEWAY_KEY" \
  -H "Authorization: Bearer $USER_KEY"
```

## Chat completion

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

## Common failures

| Symptom | Typical cause |
|---|---|
| `403 Forbidden` from API Gateway | Wrong `x-api-key` |
| `no healthy deployments` | Model/provider config not healthy or not loaded |
| `503 no_db_connection` | LiteLLM DB path unavailable |
| `Token authentication failed` | Stale proxy token vs replaced MicroVM (proxy cache mismatch) |
