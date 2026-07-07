#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="${PROMPT:-hi}"
MAX_TOKENS="${MAX_TOKENS:-16}"
TEMPERATURE="${TEMPERATURE:-0.0}"
MODELS=(
  "nova-2-lite"
  "minimax-m2.5"
  "kimi-k2.5"
)

for model in "${MODELS[@]}"; do
  echo "Testing AWS model: $model"
  MODEL="$model" \
  PROMPT="$PROMPT" \
  MAX_TOKENS="$MAX_TOKENS" \
  TEMPERATURE="$TEMPERATURE" \
    "$SCRIPT_DIR/test-api-key-strands.sh" "$@"
done
