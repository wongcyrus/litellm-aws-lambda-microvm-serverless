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
