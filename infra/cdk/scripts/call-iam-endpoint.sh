#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
OUTPUTS_FILE="output.json"
ROLE_ARN=""
API_URL=""
REQUEST_PATH="/iam/health/liveliness"
HTTP_METHOD="GET"
REQUEST_BODY=""
REQUEST_BODY_FILE=""
SESSION_DURATION_SECONDS=900

usage() {
  cat <<'EOF'
Usage:
  ./scripts/call-iam-endpoint.sh [--outputs-file <path>] [--stack <name>] [--role-arn <arn>] [--api-url <url>] [--region <aws-region>] [--path </iam/...>] [--method GET|POST|PUT|PATCH|DELETE] [--body '<json>'] [--body-file <path>] [--session-duration-seconds <seconds>]

Examples:
  ./scripts/call-iam-endpoint.sh
  ./scripts/call-iam-endpoint.sh --path /iam/models
  ./scripts/call-iam-endpoint.sh --method POST --path /iam/chat/completions --body-file ./scripts/examples/chat-body.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --outputs-file)
      OUTPUTS_FILE="$2"
      shift 2
      ;;
    --stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --role-arn)
      ROLE_ARN="$2"
      shift 2
      ;;
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
      shift 2
      ;;
    --path)
      REQUEST_PATH="$2"
      shift 2
      ;;
    --method)
      HTTP_METHOD="$2"
      shift 2
      ;;
    --body)
      REQUEST_BODY="$2"
      shift 2
      ;;
    --body-file)
      REQUEST_BODY_FILE="$2"
      shift 2
      ;;
    --session-duration-seconds)
      SESSION_DURATION_SECONDS="$2"
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

if [[ "$HTTP_METHOD" != "GET" && "$HTTP_METHOD" != "POST" && "$HTTP_METHOD" != "PUT" && "$HTTP_METHOD" != "PATCH" && "$HTTP_METHOD" != "DELETE" ]]; then
  echo "Error: --method must be one of GET|POST|PUT|PATCH|DELETE." >&2
  exit 1
fi
if [[ -n "$REQUEST_BODY" && -n "$REQUEST_BODY_FILE" ]]; then
  echo "Error: use either --body or --body-file, not both." >&2
  exit 1
fi
if [[ ! "$REQUEST_PATH" =~ ^/iam(/.*)?$ ]]; then
  echo "Error: --path must start with /iam" >&2
  exit 1
fi
if [[ ! "$SESSION_DURATION_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Error: --session-duration-seconds must be a positive integer." >&2
  exit 1
fi
if [[ "$SESSION_DURATION_SECONDS" -lt 900 || "$SESSION_DURATION_SECONDS" -gt 43200 ]]; then
  echo "Error: --session-duration-seconds must be between 900 and 43200." >&2
  exit 1
fi

if [[ -n "$REQUEST_BODY_FILE" ]]; then
  if [[ ! -f "$REQUEST_BODY_FILE" ]]; then
    echo "Error: body file not found: $REQUEST_BODY_FILE" >&2
    exit 1
  fi
  REQUEST_BODY="$(cat "$REQUEST_BODY_FILE")"
fi

if [[ -z "$ROLE_ARN" || -z "$API_URL" ]]; then
  if [[ ! -f "$OUTPUTS_FILE" ]]; then
    echo "Error: outputs file not found: $OUTPUTS_FILE" >&2
    echo "Run ./scripts/deploy-stack.sh first, or pass --role-arn and --api-url explicitly." >&2
    exit 1
  fi

  RESOLVED_VALUES="$(python - <<'PY' "$OUTPUTS_FILE" "$STACK_NAME"
import json
import sys

path = sys.argv[1]
stack = sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    obj = json.load(f)
if stack not in obj:
    raise SystemExit(f"Missing stack '{stack}' in {path}")
out = obj[stack]
role_arn = str(out.get("IamRouteCallerRoleArn") or "")
api_url = str(out.get("PublicApiInvokeUrl") or "")
if not role_arn:
    raise SystemExit("Missing IamRouteCallerRoleArn in outputs file.")
if not api_url:
    raise SystemExit("Missing PublicApiInvokeUrl in outputs file.")
print(role_arn)
print(api_url)
PY
)"

  RESOLVED_ROLE_ARN="$(printf '%s\n' "$RESOLVED_VALUES" | sed -n '1p')"
  RESOLVED_API_URL="$(printf '%s\n' "$RESOLVED_VALUES" | sed -n '2p')"

  if [[ -z "$ROLE_ARN" ]]; then
    ROLE_ARN="$RESOLVED_ROLE_ARN"
  fi
  if [[ -z "$API_URL" ]]; then
    API_URL="$RESOLVED_API_URL"
  fi
fi

if [[ -z "$ROLE_ARN" ]]; then
  echo "Error: role ARN is empty. Provide --role-arn or set it in outputs file." >&2
  exit 1
fi
if [[ -z "$API_URL" ]]; then
  echo "Error: API URL is empty. Provide --api-url or set it in outputs file." >&2
  exit 1
fi

ASSUME_JSON="$(aws sts assume-role \
  --region "$AWS_REGION" \
  --role-arn "$ROLE_ARN" \
  --role-session-name "iam-route-call-$(date +%s)" \
  --duration-seconds "$SESSION_DURATION_SECONDS" \
  --query Credentials \
  --output json)"

TEMP_ACCESS_KEY_ID="$(python - <<'PY' "$ASSUME_JSON"
import json,sys
print(json.loads(sys.argv[1])["AccessKeyId"])
PY
)"
TEMP_SECRET_ACCESS_KEY="$(python - <<'PY' "$ASSUME_JSON"
import json,sys
print(json.loads(sys.argv[1])["SecretAccessKey"])
PY
)"
TEMP_SESSION_TOKEN="$(python - <<'PY' "$ASSUME_JSON"
import json,sys
print(json.loads(sys.argv[1])["SessionToken"])
PY
)"

FULL_URL="${API_URL%/}/${REQUEST_PATH#/}"
echo "Calling: $FULL_URL"
echo "Method: $HTTP_METHOD"
echo "Role: $ROLE_ARN"

if [[ -n "$REQUEST_BODY" ]]; then
  RESPONSE="$(curl -sS -w '\n%{http_code}' \
    --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" \
    --user "${TEMP_ACCESS_KEY_ID}:${TEMP_SECRET_ACCESS_KEY}" \
    -H "x-amz-security-token: ${TEMP_SESSION_TOKEN}" \
    -H "Content-Type: application/json" \
    -X "$HTTP_METHOD" \
    --data-raw "$REQUEST_BODY" \
    "$FULL_URL")"
else
  RESPONSE="$(curl -sS -w '\n%{http_code}' \
    --aws-sigv4 "aws:amz:${AWS_REGION}:execute-api" \
    --user "${TEMP_ACCESS_KEY_ID}:${TEMP_SECRET_ACCESS_KEY}" \
    -H "x-amz-security-token: ${TEMP_SESSION_TOKEN}" \
    -H "Content-Type: application/json" \
    -X "$HTTP_METHOD" \
    "$FULL_URL")"
fi

HTTP_BODY="$(printf '%s' "$RESPONSE" | sed '$d')"
HTTP_CODE="$(printf '%s' "$RESPONSE" | tail -n1)"

echo "HTTP $HTTP_CODE"
printf '%s\n' "$HTTP_BODY"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: IAM endpoint request failed with HTTP $HTTP_CODE" >&2
  exit 1
fi
