#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
OUTPUT_FILE="output.json"
SETTINGS_FILE="cdk-settings.yaml"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-stack.sh [--config <path>] [--output-file <path>] [--stack <name>]

Examples:
  ./scripts/deploy-stack.sh
  ./scripts/deploy-stack.sh --config cdk-settings.yaml --output-file output.json
  ./scripts/deploy-stack.sh --stack PrivateLiteLlmMicrovmStack
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-file)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --config)
      SETTINGS_FILE="$2"
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

if [[ -z "$OUTPUT_FILE" ]]; then
  echo "Error: --output-file must be non-empty." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTINGS_PATH="$CDK_DIR/$SETTINGS_FILE"
if [[ "$SETTINGS_FILE" = /* ]]; then
  SETTINGS_PATH="$SETTINGS_FILE"
fi
if [[ ! -f "$SETTINGS_PATH" ]]; then
  echo "Error: settings file not found: $SETTINGS_PATH" >&2
  exit 1
fi

echo "Deploying stack: $STACK_NAME"
echo "CDK settings: $SETTINGS_PATH"
echo "Writing outputs to: $OUTPUT_FILE"

cd "$CDK_DIR"
npx cdk deploy "$STACK_NAME" \
  --require-approval never \
  --outputs-file "$OUTPUT_FILE" \
  -c settingsFile="$SETTINGS_PATH"

echo "Saved stack outputs to: $CDK_DIR/$OUTPUT_FILE"
