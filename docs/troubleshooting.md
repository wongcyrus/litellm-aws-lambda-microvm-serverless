# Troubleshooting Guide

## Logs to check first

| Location | What it helps diagnose |
|---|---|
| Proxy Lambda log group | Request forwarding, auth translation, MicroVM token/cache issues |
| `/aws/lambda-microvms/<image-name>` | In-image LiteLLM/provider runtime errors |
| API Gateway access logs | Request path/status/throttle and integration outcomes |
| API Gateway execution logs | Gateway-level auth/integration failures |

## Common failure patterns

| Symptom | Typical cause | Action |
|---|---|---|
| `403 Forbidden` at API Gateway | Missing/invalid `x-api-key` or wrong usage plan | Re-read `AwsGatewayApiKeySecretArn` and use correct key |
| `401` from LiteLLM | Missing/invalid `Authorization` bearer key | Use valid generated LiteLLM key |
| `403` on `/iam/...` | Principal ARN not mapped in table | Run `create-iam-key-mapping.sh` for that principal |
| `Token authentication failed` | Stale cached token vs replaced/restarted MicroVM | Retry and check proxy logs for cache invalidation behavior |
| Provider timeout/connect timeout | Current subnet mode/egress path does not reach target endpoint | Confirm `publicMicrovm` mode and network egress requirements |

## Runtime profile reference

- MicroVM image minimum memory: `2048 MiB`
- idle policy:
  - `maxIdleDurationSeconds = 900`
  - `suspendedDurationSeconds = 28800`
- max run duration:
  - `maximumDurationInSeconds = 28800`

## Deployment caveat: MicroVM image stabilization

`AWS::Lambda::MicrovmImage` can occasionally report `NotStabilized` in CloudFormation while a newer image version later becomes active.

Recommended handling:

1. Retry deploy.
2. Verify latest image/runtime logs.
3. Separate image retry from unrelated infra/database/network changes.
