#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="${PROMPT:-hi}"
MAX_TOKENS="${MAX_TOKENS:-16}"
TEMPERATURE="${TEMPERATURE:-0.0}"
MODELS=(
  "gpt-5.2"
  "gpt-5.4-mini"
  "gpt-5.4-nano"
  "gpt-5.4"
  "gpt-5.6-terra"
  "gpt-5.6-luna"
  "gpt-5.6-sol"
)

for model in "${MODELS[@]}"; do
  echo "Testing Azure model: $model"
  MODEL="$model" \
  PROMPT="$PROMPT" \
  MAX_TOKENS="$MAX_TOKENS" \
  TEMPERATURE="$TEMPERATURE" \
    "$SCRIPT_DIR/test-api-key-strands.sh" "$@"
done
