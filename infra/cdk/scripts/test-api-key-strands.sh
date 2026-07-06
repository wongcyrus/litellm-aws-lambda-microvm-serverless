#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${VENV_DIR:-$CDK_DIR/.venv-strands}"
API_URL="${API_URL:-}"
API_KEY="${API_KEY:-}"
API_KEY_FILE="${API_KEY_FILE:-$CDK_DIR/.keys/user-key.txt}"
MODEL="${MODEL:-nova-2-lite}"
PROMPT="${PROMPT:-Reply with exactly: ok}"
MAX_TOKENS="${MAX_TOKENS:-128}"
TEMPERATURE="${TEMPERATURE:-0.0}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/test-api-key-strands.sh [--api-url <url>] [--api-key <key>|--api-key-file <path>] [--venv <dir>] [--model <model>] [--prompt <text>] [--max-tokens <n>] [--temperature <float>] [--stack <name>] [--region <aws-region>]

Examples:
  ./scripts/test-api-key-strands.sh
  ./scripts/test-api-key-strands.sh --api-key-file .keys/app-user.txt
  ./scripts/test-api-key-strands.sh --api-url https://<id>.execute-api.us-east-1.amazonaws.com/prod --api-key sk-...

Notes:
  - Creates/reuses a Python virtualenv (default: .venv-strands)
  - Installs Strands deps in that virtualenv if missing
  - If --api-url is not provided, resolves PublicApiInvokeUrl from CloudFormation stack outputs
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --api-key)
      API_KEY="$2"
      shift 2
      ;;
    --api-key-file)
      API_KEY_FILE="$2"
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

if [[ -n "$API_KEY" && -n "$API_KEY_FILE" && "$API_KEY_FILE" != ".keys/user-key.txt" ]]; then
  echo "Error: use either --api-key or --api-key-file, not both." >&2
  exit 1
fi
if [[ -z "$API_KEY" && -z "$API_KEY_FILE" ]]; then
  echo "Error: provide --api-key or --api-key-file." >&2
  exit 1
fi

if [[ -z "$API_URL" ]]; then
  API_URL="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='PublicApiInvokeUrl'].OutputValue" \
    --output text)"
fi
if [[ -z "$API_URL" || "$API_URL" == "None" ]]; then
  echo "Error: unable to resolve API URL (PublicApiInvokeUrl)." >&2
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
PY
then
  "$PIP_BIN" install --quiet 'strands-agents[openai]' strands-agents-tools
fi

export STRANDS_API_URL="${API_URL%/}"
if [[ -n "$API_KEY" ]]; then
  export STRANDS_API_KEY="$API_KEY"
else
  if [[ ! -f "$API_KEY_FILE" ]]; then
    echo "Error: key file not found: $API_KEY_FILE" >&2
    exit 1
  fi
  export STRANDS_API_KEY="$(tr -d '\n' < "$API_KEY_FILE")"
fi
if [[ -z "$STRANDS_API_KEY" ]]; then
  echo "Error: resolved empty API key." >&2
  exit 1
fi

echo "Using API URL: $STRANDS_API_URL"
echo "Using key source: ${API_KEY:+--api-key}${API_KEY_FILE:+$API_KEY_FILE}"
echo "Using venv: $VENV_DIR"

if [[ -n "$API_KEY" ]]; then
  "$PYTHON_BIN" "$SCRIPT_DIR/test-api-key-strands.py" \
    --api-url "$STRANDS_API_URL" \
    --api-key "$STRANDS_API_KEY" \
    --model "$MODEL" \
    --prompt "$PROMPT" \
    --max-tokens "$MAX_TOKENS" \
    --temperature "$TEMPERATURE"
else
  "$PYTHON_BIN" "$SCRIPT_DIR/test-api-key-strands.py" \
    --api-url "$STRANDS_API_URL" \
    --api-key-file "$API_KEY_FILE" \
    --model "$MODEL" \
    --prompt "$PROMPT" \
    --max-tokens "$MAX_TOKENS" \
    --temperature "$TEMPERATURE"
fi
