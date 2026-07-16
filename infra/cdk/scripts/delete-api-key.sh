#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_VALUE=""
KEY_FILE=""
SKIP_IAM_MAPPING_DELETE=false
PRINT_JSON=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/delete-api-key.sh (--key <sk-...> | --key-file <path>) [--skip-iam-mapping-delete] [--json] [--stack <name>] [--region <aws-region>]

Examples:
  ./scripts/delete-api-key.sh --key sk-abc123
  ./scripts/delete-api-key.sh --key-file .keys/app-user.txt
  ./scripts/delete-api-key.sh --key-file .keys/app-user.txt --skip-iam-mapping-delete

Order of operations:
1) Delete key in LiteLLM (/key/delete) to revoke model access first
2) Delete matching API Gateway API key by value
3) Delete IAM principal mappings that reference this key (unless skipped)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)
      KEY_VALUE="$2"
      shift 2
      ;;
    --key-file)
      KEY_FILE="$2"
      shift 2
      ;;
    --skip-iam-mapping-delete)
      SKIP_IAM_MAPPING_DELETE=true
      shift 1
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

if [[ -n "$KEY_VALUE" && -n "$KEY_FILE" ]]; then
  echo "Error: use either --key or --key-file, not both." >&2
  exit 1
fi
if [[ -z "$KEY_VALUE" && -z "$KEY_FILE" ]]; then
  echo "Error: provide --key or --key-file." >&2
  exit 1
fi

if [[ -n "$KEY_FILE" ]]; then
  if [[ ! -f "$KEY_FILE" ]]; then
    echo "Error: key file not found: $KEY_FILE" >&2
    exit 1
  fi
  KEY_VALUE="$(tr -d '\n' < "$KEY_FILE")"
fi

if [[ -z "$KEY_VALUE" ]]; then
  echo "Error: resolved empty key value." >&2
  exit 1
fi
if [[ "${KEY_VALUE:0:3}" != "sk-" ]]; then
  echo "Error: key must start with 'sk-'." >&2
  exit 1
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
IAM_KEY_MAP_TABLE_NAME="$(stack_output "IamPrincipalKeyMapTableName")"

if [[ -z "$PUBLIC_API_URL" || "$PUBLIC_API_URL" == "None" ]]; then
  echo "Error: missing PublicApiInvokeUrl output on stack $STACK_NAME" >&2
  exit 1
fi
if [[ -z "$API_KEY_SECRET_ARN" || "$API_KEY_SECRET_ARN" == "None" ]]; then
  echo "Error: missing AwsGatewayApiKeySecretArn output on stack $STACK_NAME" >&2
  exit 1
fi
if [[ -z "$MASTER_KEY_SECRET_ARN" || "$MASTER_KEY_SECRET_ARN" == "None" ]]; then
  echo "Error: missing LiteLlmMasterKeySecretArn output on stack $STACK_NAME" >&2
  exit 1
fi

API_KEY_JSON="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$API_KEY_SECRET_ARN" --query SecretString --output text)"
API_GATEWAY_STACK_KEY="$(python - <<'PY' "$API_KEY_JSON"
import json
import sys
print(json.loads(sys.argv[1])["apiKey"])
PY
)"
MASTER_KEY_JSON="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$MASTER_KEY_SECRET_ARN" --query SecretString --output text)"
MASTER_KEY="$(python - <<'PY' "$MASTER_KEY_JSON"
import json
import sys
obj = json.loads(sys.argv[1])
prefix = str(obj.get("prefix") or "")
suffix = str(obj.get("suffix") or "")
if not prefix or not suffix:
    raise SystemExit("Master key secret JSON must contain prefix and suffix.")
print(prefix + suffix)
PY
)"

if [[ -z "$API_GATEWAY_STACK_KEY" || -z "$MASTER_KEY" ]]; then
  echo "Error: resolved empty stack key material from Secrets Manager." >&2
  exit 1
fi

# 1) Revoke LiteLLM key first.
DELETE_BODY="$(python - <<'PY' "$KEY_VALUE"
import json
import sys
print(json.dumps({"keys": [sys.argv[1]]}))
PY
)"
DELETE_RESPONSE="$(curl -sS -w '\n%{http_code}' -X POST "${PUBLIC_API_URL%/}/key/delete" \
  -H "x-api-key: $API_GATEWAY_STACK_KEY" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  --data-raw "$DELETE_BODY")"
DELETE_HTTP_BODY="$(printf '%s' "$DELETE_RESPONSE" | sed '$d')"
DELETE_HTTP_CODE="$(printf '%s' "$DELETE_RESPONSE" | tail -n1)"
if [[ "$DELETE_HTTP_CODE" != "200" ]]; then
  echo "Error: LiteLLM key delete failed with HTTP $DELETE_HTTP_CODE" >&2
  echo "$DELETE_HTTP_BODY" >&2
  exit 1
fi

# 2) Delete API Gateway key record with the same value.
API_GATEWAY_KEY_ID="$(aws apigateway get-api-keys \
  --region "$AWS_REGION" \
  --include-values \
  --limit 500 \
  --query "items[?value=='$KEY_VALUE'].id" \
  --output text)"
if [[ -z "$API_GATEWAY_KEY_ID" || "$API_GATEWAY_KEY_ID" == "None" ]]; then
  echo "Error: API Gateway key value not found; LiteLLM key is already revoked." >&2
  exit 1
fi
aws apigateway delete-api-key --region "$AWS_REGION" --api-key "$API_GATEWAY_KEY_ID"

# 3) Remove IAM principal mappings that still reference this key.
REMOVED_IAM_MAPPING_COUNT=0
if [[ "$SKIP_IAM_MAPPING_DELETE" == false ]]; then
  if [[ -z "$IAM_KEY_MAP_TABLE_NAME" || "$IAM_KEY_MAP_TABLE_NAME" == "None" ]]; then
    echo "Error: missing IamPrincipalKeyMapTableName output on stack $STACK_NAME" >&2
    exit 1
  fi
  PRINCIPALS="$(aws dynamodb scan \
    --region "$AWS_REGION" \
    --table-name "$IAM_KEY_MAP_TABLE_NAME" \
    --filter-expression "litellm_key = :k" \
    --expression-attribute-values "{\":k\":{\"S\":\"$KEY_VALUE\"}}" \
    --query "Items[].principal_arn.S" \
    --output text)"
  if [[ -n "$PRINCIPALS" && "$PRINCIPALS" != "None" ]]; then
    for principal in $PRINCIPALS; do
      aws dynamodb delete-item \
        --region "$AWS_REGION" \
        --table-name "$IAM_KEY_MAP_TABLE_NAME" \
        --key "{\"principal_arn\":{\"S\":\"$principal\"}}"
      REMOVED_IAM_MAPPING_COUNT=$((REMOVED_IAM_MAPPING_COUNT + 1))
    done
  fi
fi

if [[ "$PRINT_JSON" == true ]]; then
  python - <<'PY' "$KEY_VALUE" "$API_GATEWAY_KEY_ID" "$REMOVED_IAM_MAPPING_COUNT" "$SKIP_IAM_MAPPING_DELETE"
import json
import sys
print(json.dumps({
    "status": "ok",
    "deleted_key_prefix": sys.argv[1][:7],
    "api_gateway_key_id": sys.argv[2],
    "removed_iam_mapping_count": int(sys.argv[3]),
    "skip_iam_mapping_delete": sys.argv[4].lower() == "true",
}, ensure_ascii=False))
PY
else
  echo "Deleted LiteLLM key and API Gateway key."
  echo "API Gateway key id: $API_GATEWAY_KEY_ID"
  if [[ "$SKIP_IAM_MAPPING_DELETE" == false ]]; then
    echo "Removed IAM key mappings: $REMOVED_IAM_MAPPING_COUNT"
  fi
fi
