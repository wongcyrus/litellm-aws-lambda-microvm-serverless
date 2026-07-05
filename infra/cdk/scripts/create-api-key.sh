#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
KEY_ALIAS="user-key"
DURATION="24h"
MODEL_LIST=""
OUTPUT_FILE=""
PRINT_JSON=false
CUSTOM_KEY=""
USAGE_PLAN_ID=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/create-api-key.sh --usage-plan-id <id> [--alias <key-alias>] [--duration <duration>] [--models <comma-separated-models>] [--key <explicit-key>] [--output-file <path>] [--json] [--stack <name>] [--region <aws-region>]

Examples:
  ./scripts/create-api-key.sh --usage-plan-id abc123 --alias team-a --duration 7d --models nova-2-lite
  ./scripts/create-api-key.sh --usage-plan-id abc123 --alias admin-ui --duration 7d
  ./scripts/create-api-key.sh --usage-plan-id abc123 --alias ci-key --duration 24h --output-file .keys/ci_key.txt

Notes:
  By default, the key is saved to .keys/<key-alias>.txt (chmod 600).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --alias)
      KEY_ALIAS="$2"
      shift 2
      ;;
    --duration)
      DURATION="$2"
      shift 2
      ;;
    --models)
      MODEL_LIST="$2"
      shift 2
      ;;
    --usage-plan-id)
      USAGE_PLAN_ID="$2"
      shift 2
      ;;
    --key)
      CUSTOM_KEY="$2"
      shift 2
      ;;
    --output-file)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --json)
      PRINT_JSON=true
      shift 1
      ;;
    --stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$KEY_ALIAS" || -z "$DURATION" ]]; then
  echo "Error: --alias and --duration must be non-empty." >&2
  exit 1
fi
if [[ -z "$USAGE_PLAN_ID" ]]; then
  echo "Error: --usage-plan-id is required (no fallback)." >&2
  exit 1
fi
if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE=".keys/${KEY_ALIAS}.txt"
fi

stack_output() {
  local key="$1"
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}

PUBLIC_API_URL="$(stack_output "PublicApiInvokeUrl")"
API_KEY_SECRET_ARN="$(stack_output "AwsGatewayApiKeySecretArn")"
MASTER_KEY_SECRET_ARN="$(stack_output "LiteLlmMasterKeySecretArn")"

if [[ -z "$PUBLIC_API_URL" || "$PUBLIC_API_URL" == "None" ]]; then
  echo "Error: missing PublicApiInvokeUrl output on stack $STACK_NAME" >&2
  exit 1
fi
if [[ -z "$API_KEY_SECRET_ARN" || "$API_KEY_SECRET_ARN" == "None" ]]; then
  echo "Error: missing AwsGatewayApiKeySecretArn output on stack $STACK_NAME" >&2
  exit 1
fi
if [[ "$USAGE_PLAN_ID" == "None" ]]; then
  echo "Error: --usage-plan-id cannot be 'None'." >&2
  exit 1
fi
if [[ -z "$MASTER_KEY_SECRET_ARN" || "$MASTER_KEY_SECRET_ARN" == "None" ]]; then
  echo "Error: missing LiteLlmMasterKeySecretArn output on stack $STACK_NAME" >&2
  exit 1
fi

API_KEY_JSON="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$API_KEY_SECRET_ARN" --query SecretString --output text)"
API_GATEWAY_KEY="$(python -c 'import json,sys; print(json.loads(sys.stdin.read())["apiKey"])' <<<"$API_KEY_JSON")"
MASTER_KEY_JSON="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$MASTER_KEY_SECRET_ARN" --query SecretString --output text)"
MASTER_KEY="$(python - <<'PY' "$MASTER_KEY_JSON"
import json
import sys
value = sys.argv[1]
obj = json.loads(value)
prefix = str(obj.get("prefix") or "")
suffix = str(obj.get("suffix") or "")
if not prefix or not suffix:
    raise SystemExit("Master key secret JSON must contain prefix and suffix.")
print(prefix + suffix)
PY
)"

if [[ -z "$API_GATEWAY_KEY" || -z "$MASTER_KEY" ]]; then
  echo "Error: resolved empty key material from Secrets Manager." >&2
  exit 1
fi

MODELS_JSON="[]"
if [[ -n "$MODEL_LIST" ]]; then
  MODELS_JSON="$(python -c 'import json,sys; print(json.dumps([m.strip() for m in sys.argv[1].split(",") if m.strip()]))' "$MODEL_LIST")"
fi

if [[ -n "$CUSTOM_KEY" ]]; then
  GENERATED_KEY="$CUSTOM_KEY"
else
  GENERATED_KEY="$(python -c 'import secrets,string; chars=string.ascii_letters+string.digits; print("sk-" + "".join(secrets.choice(chars) for _ in range(45)))')"
fi
GENERATED_KEY_LEN="${#GENERATED_KEY}"
if (( GENERATED_KEY_LEN < 20 || GENERATED_KEY_LEN > 128 )); then
  echo "Error: key length ($GENERATED_KEY_LEN) must be 20-128 to satisfy API Gateway." >&2
  exit 1
fi
if [[ "${GENERATED_KEY:0:3}" != "sk-" ]]; then
  echo "Error: key must start with 'sk-' for LiteLLM client compatibility." >&2
  exit 1
fi

REQUEST_BODY="$(python -c 'import json,sys; print(json.dumps({"key_alias":sys.argv[1],"duration":sys.argv[2],"models":json.loads(sys.argv[3]),"key":sys.argv[4],"metadata":{"owner":"admin-script","stack":"'"$STACK_NAME"'"}}))' "$KEY_ALIAS" "$DURATION" "$MODELS_JSON" "$GENERATED_KEY")"
RESPONSE="$(curl -sS -w '\n%{http_code}' -X POST "${PUBLIC_API_URL%/}/key/generate" \
  -H "x-api-key: $API_GATEWAY_KEY" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  --data-raw "$REQUEST_BODY")"

HTTP_BODY="$(printf '%s' "$RESPONSE" | sed '$d')"
HTTP_CODE="$(printf '%s' "$RESPONSE" | tail -n1)"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: key generation failed with HTTP $HTTP_CODE" >&2
  echo "$HTTP_BODY" >&2
  exit 1
fi

RETURNED_KEY="$(python -c 'import json,sys; obj=json.loads(sys.stdin.read()); print(obj.get("key") or obj.get("token") or "")' <<<"$HTTP_BODY")"
if [[ -z "$RETURNED_KEY" ]]; then
  echo "Error: key generation succeeded but response did not include key/token." >&2
  echo "$HTTP_BODY" >&2
  exit 1
fi
if [[ "$RETURNED_KEY" != "$GENERATED_KEY" ]]; then
  echo "Error: LiteLLM returned a different key than requested." >&2
  echo "$HTTP_BODY" >&2
  exit 1
fi

API_GATEWAY_KEY_ID="$(aws apigateway create-api-key \
  --region "$AWS_REGION" \
  --name "litellm-${KEY_ALIAS}-$(date +%s)" \
  --enabled \
  --value "$GENERATED_KEY" \
  --query id \
  --output text)"
aws apigateway create-usage-plan-key \
  --region "$AWS_REGION" \
  --usage-plan-id "$USAGE_PLAN_ID" \
  --key-id "$API_GATEWAY_KEY_ID" \
  --key-type API_KEY >/dev/null
echo "Attached key to usage plan id: $USAGE_PLAN_ID"

mkdir -p "$(dirname "$OUTPUT_FILE")"
printf '%s\n' "$GENERATED_KEY" > "$OUTPUT_FILE"
chmod 600 "$OUTPUT_FILE"
echo "Saved generated key to: $OUTPUT_FILE"

if [[ "$PRINT_JSON" == true ]]; then
  printf '%s\n' "$HTTP_BODY"
else
  printf '%s\n' "$GENERATED_KEY"
fi
