#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
MICROVM_REGION="${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
PUBLIC_MICROVM="${PUBLIC_MICROVM:-true}"
API_GATEWAY_API_KEY_VALUE="${API_GATEWAY_API_KEY_VALUE:-}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-two-phase.sh --api-key <value> [--region <aws-region>] [--public-microvm true|false] [--stack <name>]

Env alternatives:
  API_GATEWAY_API_KEY_VALUE, MICROVM_REGION, PUBLIC_MICROVM, STACK_NAME

Behavior:
  Single-phase deploy (runtime always uses VPC egress connector).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)
      API_GATEWAY_API_KEY_VALUE="$2"
      shift 2
      ;;
    --region)
      MICROVM_REGION="$2"
      shift 2
      ;;
    --public-microvm)
      PUBLIC_MICROVM="$2"
      shift 2
      ;;
    --stack)
      STACK_NAME="$2"
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

if [[ -z "$API_GATEWAY_API_KEY_VALUE" ]]; then
  echo "Missing API key. Provide --api-key or API_GATEWAY_API_KEY_VALUE." >&2
  exit 1
fi

echo "Single-phase deploy"
npx cdk deploy "$STACK_NAME" --require-approval never \
  -c microvmRegion="$MICROVM_REGION" \
  -c apiGatewayApiKeyValue="$API_GATEWAY_API_KEY_VALUE" \
  -c publicMicrovm="$PUBLIC_MICROVM"

echo "Single-phase deploy completed."
