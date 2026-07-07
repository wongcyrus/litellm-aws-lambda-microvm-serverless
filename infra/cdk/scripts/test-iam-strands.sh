#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${VENV_DIR:-$CDK_DIR/.venv-strands}"
OUTPUTS_FILE="${OUTPUTS_FILE:-$CDK_DIR/output.json}"
API_URL="${API_URL:-}"
ROLE_ARN="${ROLE_ARN:-}"
MODEL="${MODEL:-nova-2-lite}"
PROMPT="${PROMPT:-Write 3 concise sentences about using LiteLLM with Amazon Bedrock in production, and include one practical reliability tip.}"
MAX_TOKENS="${MAX_TOKENS:-128}"
TEMPERATURE="${TEMPERATURE:-0.0}"
SESSION_DURATION_SECONDS="${SESSION_DURATION_SECONDS:-900}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/test-iam-strands.sh [--outputs-file <path>] [--api-url <url>] [--role-arn <arn>] [--venv <dir>] [--model <model>] [--prompt <text>] [--max-tokens <n>] [--temperature <float>] [--session-duration-seconds <n>] [--stack <name>] [--region <aws-region>]

Examples:
  ./scripts/test-iam-strands.sh
  ./scripts/test-iam-strands.sh --model nova-2-lite --prompt "Give a short production-readiness checklist for LiteLLM on Bedrock."
  ./scripts/test-iam-strands.sh --role-arn arn:aws:iam::123456789012:role/my-role --api-url https://<id>.execute-api.us-east-1.amazonaws.com/prod/

Notes:
  - Creates/reuses a Python virtualenv (default: .venv-strands)
  - Installs Strands deps in that virtualenv if missing
  - By default resolves API URL + role ARN from output.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --outputs-file)
      OUTPUTS_FILE="$2"
      shift 2
      ;;
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --role-arn)
      ROLE_ARN="$2"
      shift 2
      ;;
    --venv)
      VENV_DIR="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --prompt)
      PROMPT="$2"
      shift 2
      ;;
    --max-tokens)
      MAX_TOKENS="$2"
      shift 2
      ;;
    --temperature)
      TEMPERATURE="$2"
      shift 2
      ;;
    --session-duration-seconds)
      SESSION_DURATION_SECONDS="$2"
      shift 2
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

if [[ ! "$SESSION_DURATION_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Error: --session-duration-seconds must be a positive integer." >&2
  exit 1
fi
if [[ "$SESSION_DURATION_SECONDS" -lt 900 || "$SESSION_DURATION_SECONDS" -gt 43200 ]]; then
  echo "Error: --session-duration-seconds must be between 900 and 43200." >&2
  exit 1
fi

if [[ -z "$API_URL" || -z "$ROLE_ARN" ]]; then
  if [[ ! -f "$OUTPUTS_FILE" ]]; then
    echo "Error: outputs file not found: $OUTPUTS_FILE" >&2
    echo "Run ./scripts/deploy-stack.sh first, or pass --api-url and --role-arn explicitly." >&2
    exit 1
  fi
  RESOLVED_VALUES="$(python - <<'PY' "$OUTPUTS_FILE" "$STACK_NAME"
import json
import sys

path = sys.argv[1]
stack_name = sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
if stack_name not in data:
    raise SystemExit(f"Missing stack '{stack_name}' in outputs file: {path}")
stack_outputs = data[stack_name]
api_url = str(stack_outputs.get("PublicApiInvokeUrl") or "")
role_arn = str(stack_outputs.get("IamRouteCallerRoleArn") or "")
if not api_url:
    raise SystemExit("Missing PublicApiInvokeUrl in outputs file.")
if not role_arn:
    raise SystemExit("Missing IamRouteCallerRoleArn in outputs file.")
print(api_url)
print(role_arn)
PY
)"
  RESOLVED_API_URL="$(printf '%s\n' "$RESOLVED_VALUES" | sed -n '1p')"
  RESOLVED_ROLE_ARN="$(printf '%s\n' "$RESOLVED_VALUES" | sed -n '2p')"
  if [[ -z "$API_URL" ]]; then
    API_URL="$RESOLVED_API_URL"
  fi
  if [[ -z "$ROLE_ARN" ]]; then
    ROLE_ARN="$RESOLVED_ROLE_ARN"
  fi
fi

if [[ -z "$API_URL" ]]; then
  echo "Error: resolved empty API URL." >&2
  exit 1
fi
if [[ -z "$ROLE_ARN" ]]; then
  echo "Error: resolved empty IAM role ARN." >&2
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

PYTHON_BIN="$VENV_DIR/bin/python"
PIP_BIN="$VENV_DIR/bin/pip"
if [[ ! -x "$PYTHON_BIN" || ! -x "$PIP_BIN" ]]; then
  echo "Error: invalid virtualenv at $VENV_DIR" >&2
  exit 1
fi

if ! "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import strands
from strands.models.openai import OpenAIModel
import boto3
import httpx
from botocore.auth import SigV4Auth
PY
then
  "$PIP_BIN" install --quiet 'strands-agents[openai]' strands-agents-tools boto3 httpx botocore
fi

echo "Using API URL: ${API_URL%/}"
echo "Using role ARN: $ROLE_ARN"
echo "Using region: $AWS_REGION"
echo "Using venv: $VENV_DIR"

"$PYTHON_BIN" "$SCRIPT_DIR/test-iam-strands.py" \
  --api-url "${API_URL%/}" \
  --role-arn "$ROLE_ARN" \
  --region "$AWS_REGION" \
  --session-duration-seconds "$SESSION_DURATION_SECONDS" \
  --model "$MODEL" \
  --prompt "$PROMPT" \
  --max-tokens "$MAX_TOKENS" \
  --temperature "$TEMPERATURE"
