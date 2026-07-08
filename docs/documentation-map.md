# Documentation Map

This page is a fast index for navigating the docs set.

## Start by task

| Need | Go to |
|---|---|
| Architecture, network modes, and proxy flow | `docs/cdk-design.md` |
| Deploy, destroy, and script flags | `docs/deployment.md` |
| Auth model, keys, IAM route, OpenClaw settings | `docs/auth-and-keys.md` |
| End-to-end API examples | `docs/api-usage.md` |
| Provider and IAM/API-key test runners | `docs/testing.md` |
| Logs, failures, and recovery notes | `docs/troubleshooting.md` |

## Tables index

| Table | File |
|---|---|
| Mode comparison (security + cost) | `docs/cdk-design.md` |
| Deploy script flags | `docs/deployment.md` |
| API key script flags | `docs/deployment.md` |
| Vertex service account script flags | `docs/deployment.md` |
| Admin UI connect script flags | `docs/deployment.md` |
| IAM key mapping script flags | `docs/deployment.md` |
| IAM endpoint call script flags | `docs/deployment.md` |
| API common failures | `docs/api-usage.md` |
| Troubleshooting failure patterns | `docs/troubleshooting.md` |

## Diagrams index

| Diagram | File |
|---|---|
| `publicMicrovm=true` architecture | `docs/cdk-design.md` |
| `publicMicrovm=false` architecture | `docs/cdk-design.md` |
| Lambda proxy call interaction | `docs/cdk-design.md` |
| IAM -> LiteLLM key flow | `docs/auth-and-keys.md` |

## Core implementation files

- `infra/cdk/lib/private-litellm-microvm-stack.ts`
- `infra/cdk/lib/stack/networking.ts`
- `infra/cdk/lambda/microvm_proxy.py`
- `infra/cdk/lambda/microvm_cleanup.py`
- `infra/cdk/microvm-image/config.yaml`

## Important CloudFormation outputs

| Output | Use |
|---|---|
| `PublicApiInvokeUrl` | Base API URL |
| `AwsGatewayApiKeySecretArn` | Secret for `x-api-key` |
| `LiteLlmMasterKeySecretArn` | Secret for LiteLLM master key parts |
| `AwsGatewayUsagePlanId` | Public/API usage plan ID |
| `AwsGatewayAdminUsagePlanId` | Admin usage plan ID |
| `IamPrincipalKeyMapTableName` | IAM principal mapping table |
| `IamRouteCallerRoleArn` | IAM route caller role |
| `MicrovmSubnetMode` | Current mode (`public` or `private-with-nat`) |
