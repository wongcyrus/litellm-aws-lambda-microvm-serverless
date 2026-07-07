#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT="${PROMPT:-hi}"
MAX_TOKENS="${MAX_TOKENS:-16}"
TEMPERATURE="${TEMPERATURE:-0.0}"
MODELS=(
  "gemini-3.5-flash"
  "gemini-3.1-flash-lite"
  "gemini-3.1-flash-image-preview"
  "gemini-3.1-pro-preview"
  "gemini-3.1-pro-preview-customtools"
  "gemini-2.5-pro"
  "gemini-2.5-flash"
  "gemini-2.5-flash-lite"
)

for model in "${MODELS[@]}"; do
  echo "Testing GCP model: $model"
  MODEL="$model" \
  PROMPT="$PROMPT" \
  MAX_TOKENS="$MAX_TOKENS" \
  TEMPERATURE="$TEMPERATURE" \
    "$SCRIPT_DIR/test-api-key-strands.sh" "$@"
done
