# LiteLLM AWS Lambda MicroVM Serverless

AWS-only repository for running LiteLLM on Lambda MicroVM with Aurora PostgreSQL and API Gateway.

## What this repo contains

- CDK stack for:
  - Lambda MicroVM image + runtime
  - API Gateway + usage plans + API keys
  - Aurora Serverless v2 PostgreSQL
  - Proxy Lambda for MicroVM auth/token forwarding
  - CloudWatch log retention (7 days)
- AWS operational scripts under `infra/cdk/scripts/`

## Repository layout

```text
infra/cdk/
  bin/
  lib/
  lambda/
  microvm-image/
  scripts/
    create-api-key.sh
    connect-admin-ui.sh
    destroy-stack.sh
```

## Deploy

```bash
cd infra/cdk
npm install
npm run build
npx cdk deploy PrivateLiteLlmMicrovmStack --require-approval never -c microvmRegion=us-east-1 -c publicMicrovm=true
```

## Auth model

API requests use two layers:

1. API Gateway usage-plan key in `x-api-key`
2. LiteLLM key in `Authorization: Bearer <key>`

CDK outputs:

- `AwsGatewayApiKeySecretArn`
- `LiteLlmMasterKeySecretArn`
- `AwsGatewayUsagePlanId`
- `AwsGatewayAdminUsagePlanId`
- `PublicApiInvokeUrl`

## Create API keys for users

```bash
cd infra/cdk
./scripts/create-api-key.sh --alias team-a --duration 7d --models nova-2-lite
```

Admin/UI usage-plan key:

```bash
./scripts/create-api-key.sh --alias admin-ui --duration 7d --usage-plan admin
```

## Admin web UI (direct MicroVM local connector)

```bash
cd infra/cdk
./scripts/connect-admin-ui.sh
```

Then open:

- `http://127.0.0.1:8787/ui`

The script prints the LiteLLM admin login key (master key).

## Destroy

```bash
cd infra/cdk
./scripts/destroy-stack.sh
```

## Notes

- This repository is intentionally AWS-only.
- Non-AWS local setup files were removed.
