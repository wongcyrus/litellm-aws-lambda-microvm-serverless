# Deployment Guide

## CDK settings

Edit `infra/cdk/cdk-settings.yaml`:

```yaml
microvmRegion: us-east-1
# Optional only for Vertex/GCP models:
# vertexAiProject: <gcp-project-id>
# vertexAiLocation: <gcp-region>
# vertexCredentialsFile: /absolute/path/to/vertex-service-account.json
# Optional only for Azure models:
# azureOpenAiConfigFile: /absolute/path/to/azure-openai.json
publicMicrovm: true
useCodebuildEcrBaseImage: false
```

Optional env-based paths:

```bash
export VERTEX_CREDENTIALS_FILE=/absolute/path/to/vertex-sa.json
export AZURE_OPENAI_CONFIG_FILE=/absolute/path/to/azure-openai.json
```

## Deploy

```bash
cd infra/cdk
./scripts/deploy-stack.sh --config cdk-settings.yaml --stack PrivateLiteLlmMicrovmStack
```

Direct CDK:

```bash
cd infra/cdk
npm install
npm run build
npx cdk deploy PrivateLiteLlmMicrovmStack --require-approval never -c settingsFile=cdk-settings.yaml
```

## Destroy

```bash
cd infra/cdk
npx cdk destroy PrivateLiteLlmMicrovmStack --force -c settingsFile=cdk-settings.yaml
```

## Notes

- `publicMicrovm=false` enables NAT egress and is required when runtime must call non-AWS internet providers.
- `output.json` is written by `deploy-stack.sh` and used by other scripts for stack outputs.

## Script reference (important)

### `scripts/deploy-stack.sh`

Deploys `PrivateLiteLlmMicrovmStack` and writes stack outputs JSON.

| Flag | Required | Description |
|---|---|---|
| `--config` | no | CDK settings YAML path (`default: cdk-settings.yaml`) |
| `--output-file` | no | Output JSON path under `infra/cdk` (`default: output.json`) |
| `--stack` | no | Stack name override |

### `scripts/create-api-key.sh`

Generates one LiteLLM key and registers the same value in API Gateway usage plan.

| Flag | Required | Description |
|---|---|---|
| `--usage-plan-id` | yes | API Gateway usage plan id to attach key |
| `--alias` | yes | Key alias in LiteLLM |
| `--duration` | no | Key duration (`default: 24h`) |
| `--models` | no | Comma-separated model allowlist |
| `--max-budget` | no | USD budget limit |
| `--budget-duration` | no | Budget window (`1d`, `7d`, etc.) |
| `--key-type` | no | `llm_api`, `management`, `read_only`, `default` |
| `--output-file` | no | Output key file path |
| `--stack` | no | Stack name override |
| `--region` | no | Region override |

Fail-fast behavior:

- no fallback defaults for missing required params
- key must start with `sk-`
- key length must be `20-128` (API Gateway constraint)
- script fails if `/key/generate` returns a different key

### `scripts/create-vertex-service-account.sh`

Creates a Vertex-ready GCP service account key JSON and grants required roles.

| Flag | Required | Description |
|---|---|---|
| `--project-id` | yes | GCP project id |
| `--service-account-id` | no | Service-account id (`default: litellm-vertex-gemini`) |
| `--display-name` | no | Service-account display name |
| `--output-file` | no | Output JSON key path |
| `--overwrite` | no | Overwrite existing output file (`true/false`) |
| `--grant-service-usage-consumer` | no | Also grant `roles/serviceusage.serviceUsageConsumer` |

### `scripts/connect-admin-ui.sh`

Starts a local direct-MicroVM admin UI proxy and writes admin key to a local file.

| Flag | Required | Description |
|---|---|---|
| `--port` | no | Local listen port (`default: 8787`) |
| `--microvm-port` | no | Upstream MicroVM app port (`default: 4000`) |
| `--token-minutes` | no | Auth token lifetime minutes |
| `--master-key-file` | no | Local admin key file path |
| `--no-start` | no | Do not auto-start a MicroVM if none is running |
| `--stack` | no | Stack name override |
| `--region` | no | Region override |

### `scripts/create-iam-key-mapping.sh`

Creates a LiteLLM key and stores IAM principal ARN mapping for `/iam/...` routes.

| Flag | Required | Description |
|---|---|---|
| `--principal-arn` | yes | IAM principal ARN to map |
| `--alias` | yes | Key alias |
| `--duration` | no | Key duration (`default: 24h`) |
| `--models` | no | Comma-separated model allowlist |
| `--key` | no | Explicit key value |
| `--output-file` | no | Output key file path |
| `--stack` | no | Stack name override |
| `--region` | no | Region override |

### `scripts/call-iam-endpoint.sh`

Assumes IAM role and sends SigV4-signed requests to `/iam/...` endpoints.

| Flag | Required | Description |
|---|---|---|
| `--outputs-file` | no | Outputs JSON path (`default: output.json`) |
| `--stack` | no | Stack key in outputs JSON |
| `--role-arn` | no | Explicit role ARN override |
| `--api-url` | no | Explicit API URL override |
| `--region` | no | Region override |
| `--path` | no | IAM path (`default: /iam/health/liveliness`) |
| `--method` | no | HTTP method (`GET/POST/PUT/PATCH/DELETE`) |
| `--body` | no | Inline JSON body |
| `--body-file` | no | JSON body file |
| `--session-duration-seconds` | no | STS session duration (default `900`) |
