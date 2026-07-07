#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
PUBLIC_MICROVM="true"
OUTPUT_FILE="output.json"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-stack.sh [--public-microvm true|false] [--output-file <path>] [--stack <name>] [--region <aws-region>]

Examples:
  ./scripts/deploy-stack.sh
  ./scripts/deploy-stack.sh --public-microvm false --output-file output.json
  ./scripts/deploy-stack.sh --stack PrivateLiteLlmMicrovmStack --region us-east-1
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-microvm)
      PUBLIC_MICROVM="$2"
      shift 2
      ;;
    --output-file)
      OUTPUT_FILE="$2"
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

if [[ "$PUBLIC_MICROVM" != "true" && "$PUBLIC_MICROVM" != "false" ]]; then
  echo "Error: --public-microvm must be true or false." >&2
  exit 1
fi
if [[ -z "$OUTPUT_FILE" ]]; then
  echo "Error: --output-file must be non-empty." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Deploying stack: $STACK_NAME"
echo "Region: $AWS_REGION"
echo "publicMicrovm: $PUBLIC_MICROVM"
echo "Writing outputs to: $OUTPUT_FILE"

cd "$CDK_DIR"
npx cdk deploy "$STACK_NAME" \
  --require-approval never \
  --outputs-file "$OUTPUT_FILE" \
  -c microvmRegion="$AWS_REGION" \
  -c publicMicrovm="$PUBLIC_MICROVM"

echo "Saved stack outputs to: $CDK_DIR/$OUTPUT_FILE"
