#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
OUTPUTS_FILE="${OUTPUTS_FILE:-$CDK_DIR/output.json}"

KEY_ALIAS=""
DURATION=""
MODEL_LIST=""
OUTPUT_FILE=""
PRINT_JSON=false
QUIET=false
MAX_BUDGET=""
BUDGET_DURATION=""
USAGE_PLAN_ID=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/create-client-key.sh [--alias <key-alias>] [--duration <duration>] [--models <comma-separated-models>] [--max-budget <usd>] [--budget-duration <duration>] [--output-file <path>] [--usage-plan-id <id>] [--json] [-q|--quiet] [--stack <name>] [--region <aws-region>]

Description:
  Generates a non-admin client API key (key_type=llm_api) for LiteLLM and registers
  it in the API Gateway public usage plan. This key is restricted to inference
  endpoints (e.g. /chat/completions) and cannot perform admin operations.

Examples:
  # Quick generate with defaults (auto-resolves endpoint & plan, non-expiring):
  ./scripts/create-client-key.sh

  # Generate with custom alias:
  ./scripts/create-client-key.sh --alias my-app

  # Generate with a $10 daily budget limit:
  ./scripts/create-client-key.sh --alias app-user --max-budget 10 --budget-duration 1d

  # Generate with 30-day duration and specific model:
  ./scripts/create-client-key.sh --alias partner-service --duration 30d --models nova-2-lite

  # Output in JSON format (useful for automation/CI):
  ./scripts/create-client-key.sh --alias ci-client --json

Notes:
  - Key type is strictly enforced as "llm_api" (non-admin).
  - Automatically queries AwsGatewayUsagePlanId and PublicApiInvokeUrl from stack outputs.
  - Saved to .keys/<key-alias>.txt (chmod 600) by default.
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
    --max-budget)
      MAX_BUDGET="$2"
      shift 2
      ;;
    --budget-duration)
      BUDGET_DURATION="$2"
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
    -q|--quiet)
      QUIET=true
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

if [[ -n "$MAX_BUDGET" && -z "$BUDGET_DURATION" ]]; then
  echo "Error: --budget-duration is required when --max-budget is set (e.g., 1d, 30d)." >&2
  exit 1
fi
if [[ -n "$BUDGET_DURATION" && -z "$MAX_BUDGET" ]]; then
  echo "Error: --max-budget is required when --budget-duration is set." >&2
  exit 1
fi
if [[ -n "$MAX_BUDGET" ]] && ! [[ "$MAX_BUDGET" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Error: --max-budget must be a non-negative number (USD)." >&2
  exit 1
fi

if [[ -z "$KEY_ALIAS" ]]; then
  KEY_ALIAS="client-$(date +%Y%m%d-%H%M%S)"
fi

if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE="$CDK_DIR/.keys/${KEY_ALIAS}.txt"
fi

resolve_output() {
  local key="$1"
  local val=""

  # 1. Try reading from output.json if present
  if [[ -f "$OUTPUTS_FILE" ]]; then
    val="$(python3 - <<'PY' "$OUTPUTS_FILE" "$STACK_NAME" "$key" 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    stack_data = data.get(sys.argv[2], {})
    val = stack_data.get(sys.argv[3])
    if val and val != "None":
        print(val)
except Exception:
    pass
PY
)"
  fi

  # 2. Fall back to CloudFormation describe-stacks
  if [[ -z "$val" || "$val" == "None" ]]; then
    val="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$AWS_REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
      --output text 2>/dev/null || true)"
  fi

  printf '%s' "$val"
}

if [[ -z "$USAGE_PLAN_ID" ]]; then
  USAGE_PLAN_ID="$(resolve_output "AwsGatewayUsagePlanId")"
fi
if [[ -z "$USAGE_PLAN_ID" || "$USAGE_PLAN_ID" == "None" ]]; then
  echo "Error: unable to resolve AwsGatewayUsagePlanId for stack '$STACK_NAME' in region '$AWS_REGION'." >&2
  echo "Please verify stack status or specify --usage-plan-id explicitly." >&2
  exit 1
fi

PUBLIC_API_URL="$(resolve_output "PublicApiInvokeUrl")"
if [[ -z "$PUBLIC_API_URL" || "$PUBLIC_API_URL" == "None" ]]; then
  echo "Error: unable to resolve PublicApiInvokeUrl for stack '$STACK_NAME' in region '$AWS_REGION'." >&2
  echo "Please verify stack status." >&2
  exit 1
fi

CREATE_API_KEY_SCRIPT="$SCRIPT_DIR/create-api-key.sh"
if [[ ! -f "$CREATE_API_KEY_SCRIPT" ]]; then
  echo "Error: create-api-key.sh not found at $CREATE_API_KEY_SCRIPT" >&2
  exit 1
fi

CMD=(
  "$CREATE_API_KEY_SCRIPT"
  --usage-plan-id "$USAGE_PLAN_ID"
  --alias "$KEY_ALIAS"
  --key-type "llm_api"
  --stack "$STACK_NAME"
  --region "$AWS_REGION"
  --output-file "$OUTPUT_FILE"
)

if [[ -n "$DURATION" ]]; then
  CMD+=(--duration "$DURATION")
fi
if [[ -n "$MODEL_LIST" ]]; then
  CMD+=(--models "$MODEL_LIST")
fi
if [[ -n "$MAX_BUDGET" ]]; then
  CMD+=(--max-budget "$MAX_BUDGET")
fi
if [[ -n "$BUDGET_DURATION" ]]; then
  CMD+=(--budget-duration "$BUDGET_DURATION")
fi

# Run key generation quietly or with internal output redirected
if [[ "$QUIET" == true || "$PRINT_JSON" == true ]]; then
  "${CMD[@]}" >/dev/null
else
  "${CMD[@]}" >/dev/null
fi

if [[ ! -f "$OUTPUT_FILE" ]]; then
  echo "Error: expected output key file not found at $OUTPUT_FILE" >&2
  exit 1
fi

GENERATED_KEY="$(tr -d '\n\r' < "$OUTPUT_FILE")"

if [[ -z "$GENERATED_KEY" ]]; then
  echo "Error: generated key file is empty." >&2
  exit 1
fi

if [[ "$QUIET" == true ]]; then
  printf '%s\n' "$GENERATED_KEY"
  exit 0
fi

if [[ "$PRINT_JSON" == true ]]; then
  python3 - <<'PY' "$PUBLIC_API_URL" "$GENERATED_KEY" "$KEY_ALIAS" "$OUTPUT_FILE" "$USAGE_PLAN_ID" "$DURATION" "$MAX_BUDGET" "$BUDGET_DURATION"
import json, sys
data = {
    "status": "success",
    "endpoint": sys.argv[1],
    "api_key": sys.argv[2],
    "key_alias": sys.argv[3],
    "key_type": "llm_api",
    "output_file": sys.argv[4],
    "usage_plan_id": sys.argv[5],
}
if sys.argv[6]:
    data["duration"] = sys.argv[6]
if sys.argv[7]:
    data["max_budget"] = float(sys.argv[7])
    data["budget_duration"] = sys.argv[8]
print(json.dumps(data, indent=2))
PY
  exit 0
fi

cat <<EOF

================================================================================
LiteLLM Client API Key Generated Successfully
================================================================================
Role:         Client (non-admin, key_type: llm_api)
Endpoint:     ${PUBLIC_API_URL}
API Key:      ${GENERATED_KEY}
Alias:        ${KEY_ALIAS}
Saved to:     ${OUTPUT_FILE}
Usage Plan:   ${USAGE_PLAN_ID} (Public Client Usage Plan)
${DURATION:+Duration:     ${DURATION}
}${MAX_BUDGET:+Budget:       \$${MAX_BUDGET} per ${BUDGET_DURATION}
}
--------------------------------------------------------------------------------
Quick Test (cURL):
--------------------------------------------------------------------------------
curl -sS -X POST "${PUBLIC_API_URL%/}/chat/completions" \\
  -H "x-api-key: ${GENERATED_KEY}" \\
  -H "Authorization: Bearer ${GENERATED_KEY}" \\
  -H "Content-Type: application/json" \\
  --data '{
    "model": "nova-2-lite",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

--------------------------------------------------------------------------------
Python (OpenAI SDK):
--------------------------------------------------------------------------------
from openai import OpenAI

client = OpenAI(
    base_url="${PUBLIC_API_URL%/}",
    api_key="${GENERATED_KEY}",
    default_headers={"x-api-key": "${GENERATED_KEY}"},
    max_retries=2,
)

response = client.chat.completions.create(
    model="nova-2-lite",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)

--------------------------------------------------------------------------------
Environment Variables:
--------------------------------------------------------------------------------
export OPENAI_BASE_URL="${PUBLIC_API_URL%/}"
export OPENAI_API_KEY="${GENERATED_KEY}"
================================================================================
EOF
