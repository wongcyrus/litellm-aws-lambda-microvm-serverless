#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=""
SERVICE_ACCOUNT_ID="litellm-vertex-gemini"
DISPLAY_NAME="LiteLLM Vertex Gemini Caller"
OUTPUT_FILE=""
OVERWRITE="false"
GRANT_SERVICE_USAGE_CONSUMER="false"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/create-vertex-service-account.sh --project-id <gcp-project-id> [--service-account-id <id>] [--display-name <name>] [--output-file <path>] [--overwrite true|false] [--grant-service-usage-consumer true|false]

Examples:
  ./scripts/create-vertex-service-account.sh --project-id my-gcp-project
  ./scripts/create-vertex-service-account.sh --project-id my-gcp-project --output-file .keys/vertex-sa.json
  ./scripts/create-vertex-service-account.sh --project-id my-gcp-project --service-account-id litellm-prod --overwrite true

Notes:
  - Creates a GCP service account key JSON for LiteLLM Vertex usage.
  - Grants roles/aiplatform.user (minimum available Vertex role in this environment for Gemini calls).
  - Optionally grants roles/serviceusage.serviceUsageConsumer.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id)
      PROJECT_ID="$2"
      shift 2
      ;;
    --service-account-id)
      SERVICE_ACCOUNT_ID="$2"
      shift 2
      ;;
    --display-name)
      DISPLAY_NAME="$2"
      shift 2
      ;;
    --output-file)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --overwrite)
      OVERWRITE="$2"
      shift 2
      ;;
    --grant-service-usage-consumer)
      GRANT_SERVICE_USAGE_CONSUMER="$2"
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

if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: --project-id is required." >&2
  exit 1
fi
if [[ -z "$SERVICE_ACCOUNT_ID" ]]; then
  echo "Error: --service-account-id must be non-empty." >&2
  exit 1
fi
if [[ "$OVERWRITE" != "true" && "$OVERWRITE" != "false" ]]; then
  echo "Error: --overwrite must be true or false." >&2
  exit 1
fi
if [[ "$GRANT_SERVICE_USAGE_CONSUMER" != "true" && "$GRANT_SERVICE_USAGE_CONSUMER" != "false" ]]; then
  echo "Error: --grant-service-usage-consumer must be true or false." >&2
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud CLI is required but not found in PATH." >&2
  exit 1
fi

SA_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE=".keys/vertex-${PROJECT_ID}-${SERVICE_ACCOUNT_ID}.json"
fi

if [[ -f "$OUTPUT_FILE" && "$OVERWRITE" != "true" ]]; then
  echo "Error: output file already exists: $OUTPUT_FILE (use --overwrite true to replace)." >&2
  exit 1
fi

echo "Enabling required API: aiplatform.googleapis.com"
gcloud services enable aiplatform.googleapis.com --project "$PROJECT_ID" >/dev/null

if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Service account already exists: $SA_EMAIL"
else
  echo "Creating service account: $SA_EMAIL"
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --display-name "$DISPLAY_NAME" \
    --project "$PROJECT_ID" >/dev/null
fi

echo "Granting IAM role: roles/aiplatform.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" \
  --role "roles/aiplatform.user" \
  --condition=None >/dev/null

if [[ "$GRANT_SERVICE_USAGE_CONSUMER" == "true" ]]; then
  echo "Granting optional IAM role: roles/serviceusage.serviceUsageConsumer"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role "roles/serviceusage.serviceUsageConsumer" \
    --condition=None >/dev/null
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
echo "Creating key JSON: $OUTPUT_FILE"
gcloud iam service-accounts keys create "$OUTPUT_FILE" \
  --iam-account "$SA_EMAIL" \
  --project "$PROJECT_ID" >/dev/null
chmod 600 "$OUTPUT_FILE"

cat <<EOF
Done.

Service account email:
  $SA_EMAIL

Key file:
  $OUTPUT_FILE

LiteLLM config example:
  vertex_credentials: os.environ/VERTEX_CREDENTIALS
  vertex_project: os.environ/VERTEX_PROJECT
  vertex_location: os.environ/VERTEX_LOCATION

Environment variable example:
  export VERTEX_CREDENTIALS='$(cat "$OUTPUT_FILE")'
  export VERTEX_PROJECT='$PROJECT_ID'
  export VERTEX_LOCATION='us-central1'
EOF
