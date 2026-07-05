#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
MICROVM_REGION="${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
PUBLIC_MICROVM="${PUBLIC_MICROVM:-true}"

echo "Destroying stack $STACK_NAME"
npx cdk destroy "$STACK_NAME" --force \
  -c microvmRegion="$MICROVM_REGION" \
  -c publicMicrovm="$PUBLIC_MICROVM"
