# LiteLLM AWS Lambda MicroVM Serverless

<img src="./logo.png" alt="Logo" width="280" />

AWS deployment of LiteLLM on Lambda MicroVM with Aurora Serverless v2, API Gateway, and CDK.

## Documentation

- [CDK Design](docs/cdk-design.md)
- [Deployment Guide](docs/deployment.md)
- [Authentication and Keys](docs/auth-and-keys.md) (includes IAM -> LiteLLM key flow diagram)
- [Testing Guide](docs/testing.md)
- [API Usage Guide](docs/api-usage.md)

## Quick Start

```bash
cd infra/cdk
./scripts/deploy-stack.sh --config cdk-settings.yaml --stack PrivateLiteLlmMicrovmStack
```

Generate an app key (LLM-only, daily budget):

```bash
cd infra/cdk
PUBLIC_PLAN_ID=$(aws cloudformation describe-stacks --stack-name PrivateLiteLlmMicrovmStack --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='AwsGatewayUsagePlanId'].OutputValue" --output text)
./scripts/create-api-key.sh --usage-plan-id "$PUBLIC_PLAN_ID" --alias app-user --max-budget 10 --budget-duration 1d --key-type llm_api --output-file .keys/user-key.txt
```
