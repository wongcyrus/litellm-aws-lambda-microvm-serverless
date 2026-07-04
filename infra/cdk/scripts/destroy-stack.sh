#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
MICROVM_REGION="${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
API_GATEWAY_API_KEY_VALUE="${API_GATEWAY_API_KEY_VALUE:-}"
PUBLIC_MICROVM="${PUBLIC_MICROVM:-true}"

if [[ -z "$API_GATEWAY_API_KEY_VALUE" ]]; then
  echo "Missing API key. Provide --context apiGatewayApiKeyValue or API_GATEWAY_API_KEY_VALUE." >&2
  exit 1
fi

IMAGE_ARN="arn:aws:lambda:${MICROVM_REGION}:$(aws sts get-caller-identity --query Account --output text):microvm-image:${STACK_NAME}-litellm-bedrock-private"

echo "Terminating stack MicroVMs for image: $IMAGE_ARN"
mapfile -t MICROVM_IDS < <(aws lambda-microvms list-microvms --region "$MICROVM_REGION" --query "items[?imageArn=='$IMAGE_ARN' && state!='TERMINATED'].microvmId" --output text)
for id in "${MICROVM_IDS[@]:-}"; do
  if [[ -n "$id" ]]; then
    aws lambda-microvms terminate-microvm --region "$MICROVM_REGION" --microvm-identifier "$id" >/dev/null || true
    echo "terminated: $id"
  fi
done

echo "Destroying stack $STACK_NAME"
npx cdk destroy "$STACK_NAME" --force \
  -c microvmRegion="$MICROVM_REGION" \
  -c apiGatewayApiKeyValue="$API_GATEWAY_API_KEY_VALUE" \
  -c publicMicrovm="$PUBLIC_MICROVM"
