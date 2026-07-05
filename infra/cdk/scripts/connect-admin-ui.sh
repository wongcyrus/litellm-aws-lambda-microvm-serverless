#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-PrivateLiteLlmMicrovmStack}"
AWS_REGION="${AWS_REGION:-${MICROVM_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}}"
LISTEN_PORT="${LISTEN_PORT:-8787}"
MICROVM_PORT="${MICROVM_PORT:-4000}"
TOKEN_MINUTES="${TOKEN_MINUTES:-60}"
START_IF_NEEDED=true
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_PATH="$(cd "$SCRIPT_DIR/../lambda/botocore_data" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/connect-admin-ui.sh [--port <local-port>] [--microvm-port <port>] [--token-minutes <minutes>] [--no-start] [--stack <name>] [--region <aws-region>]

Examples:
  ./scripts/connect-admin-ui.sh
  ./scripts/connect-admin-ui.sh --port 8788
  ./scripts/connect-admin-ui.sh --no-start

Notes:
  * Connects directly to AWS Lambda MicroVM endpoint (not API Gateway).
  * Starts local proxy at http://127.0.0.1:<port>/ui
  * If no RUNNING MicroVM exists for stack image, script starts one unless --no-start is set.
  * MicroVM auth token expires; rerun script when expired.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      LISTEN_PORT="$2"
      shift 2
      ;;
    --microvm-port)
      MICROVM_PORT="$2"
      shift 2
      ;;
    --token-minutes)
      TOKEN_MINUTES="$2"
      shift 2
      ;;
    --no-start)
      START_IF_NEEDED=false
      shift 1
      ;;
    --stack)
      STACK_NAME="$2"
      shift 2
      ;;
    --region)
      AWS_REGION="$2"
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

MICROVM_IMAGE_IDENTIFIER="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmImageRef'].OutputValue" \
  --output text)"
MICROVM_EXECUTION_ROLE_ARN="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='MicrovmExecutionRoleArn'].OutputValue" \
  --output text)"
PROXY_FUNCTION_NAME="$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --logical-resource-id "MicrovmAuthProxyFunctionAC798DFD" \
  --query "StackResourceDetail.PhysicalResourceId" \
  --output text)"
MICROVM_EGRESS_CONNECTOR_ARN="$(aws lambda get-function-configuration \
  --region "$AWS_REGION" \
  --function-name "$PROXY_FUNCTION_NAME" \
  --query "Environment.Variables.MICROVM_EGRESS_CONNECTOR_ARN" \
  --output text)"

if [[ -z "$MICROVM_IMAGE_IDENTIFIER" || "$MICROVM_IMAGE_IDENTIFIER" == "None" ]]; then
  echo "Error: missing MicrovmImageRef output on stack $STACK_NAME" >&2
  exit 1
fi
if [[ -z "$MICROVM_EXECUTION_ROLE_ARN" || "$MICROVM_EXECUTION_ROLE_ARN" == "None" ]]; then
  echo "Error: missing MicrovmExecutionRoleArn output on stack $STACK_NAME" >&2
  exit 1
fi
if [[ -z "$MICROVM_EGRESS_CONNECTOR_ARN" || "$MICROVM_EGRESS_CONNECTOR_ARN" == "None" ]]; then
  echo "Error: missing MICROVM_EGRESS_CONNECTOR_ARN in proxy function environment." >&2
  exit 1
fi

python - <<'PY' "$AWS_REGION" "$MICROVM_IMAGE_IDENTIFIER" "$MICROVM_EXECUTION_ROLE_ARN" "$MICROVM_EGRESS_CONNECTOR_ARN" "$MICROVM_PORT" "$TOKEN_MINUTES" "$LISTEN_PORT" "$START_IF_NEEDED" "$MODEL_PATH"
import http.server
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3

region = sys.argv[1]
image_identifier = sys.argv[2]
execution_role_arn = sys.argv[3]
egress_connector_arn = sys.argv[4]
microvm_port = int(sys.argv[5])
token_minutes = int(sys.argv[6])
listen_port = int(sys.argv[7])
start_if_needed = sys.argv[8].lower() == "true"
model_path = sys.argv[9]

existing_data_path = os.environ.get("AWS_DATA_PATH")
os.environ["AWS_DATA_PATH"] = model_path if not existing_data_path else f"{model_path}:{existing_data_path}"

client = boto3.client("lambda-microvms", region_name=region)


def matches_image(image_arn: str) -> bool:
    if image_identifier.startswith("arn:aws:lambda:"):
        return image_arn == image_identifier
    return image_arn.endswith(f":microvm-image:{image_identifier}")


def find_running_microvm() -> tuple[str, str] | None:
    paginator = client.get_paginator("list_microvms")
    for page in paginator.paginate():
        for item in page.get("items", []):
            if item.get("state") != "RUNNING":
                continue
            if not matches_image(str(item.get("imageArn") or "")):
                continue
            microvm_id = str(item["microvmId"])
            detail = client.get_microvm(microvmIdentifier=microvm_id)
            endpoint = str(detail.get("endpoint") or "")
            egress = detail.get("egressNetworkConnectors") or []
            has_vpc_egress = egress_connector_arn in [str(arn) for arn in egress]
            if endpoint and has_vpc_egress:
                return microvm_id, endpoint
    return None


def start_microvm() -> tuple[str, str]:
    ingress_connector = f"arn:aws:lambda:{region}:aws:network-connector:aws-network-connector:ALL_INGRESS"
    run_resp = client.run_microvm(
        imageIdentifier=image_identifier,
        executionRoleArn=execution_role_arn,
        ingressNetworkConnectors=[ingress_connector],
        egressNetworkConnectors=[egress_connector_arn],
        idlePolicy={
            "autoResumeEnabled": True,
            "maxIdleDurationSeconds": 900,
            "suspendedDurationSeconds": 28800,
        },
        maximumDurationInSeconds=28800,
    )
    microvm_id = str(run_resp["microvmId"])
    for _ in range(120):
        detail = client.get_microvm(microvmIdentifier=microvm_id)
        state = str(detail.get("state") or "")
        if state == "RUNNING":
            endpoint = str(detail.get("endpoint") or "")
            if endpoint:
                return microvm_id, endpoint
        if state in {"TERMINATED", "TERMINATING"}:
            raise RuntimeError(f"MicroVM terminated during startup: {detail.get('stateReason', 'unknown')}")
        time.sleep(1)
    raise RuntimeError("Timed out waiting for MicroVM RUNNING state.")


running = find_running_microvm()
if running is None:
    if not start_if_needed:
        raise SystemExit("No RUNNING MicroVM found for stack image. Re-run without --no-start to start one.")
    running = start_microvm()

microvm_id, microvm_endpoint = running
token_resp = client.create_microvm_auth_token(
    microvmIdentifier=microvm_id,
    expirationInMinutes=token_minutes,
    allowedPorts=[{"port": microvm_port}],
)
proxy_auth_token = token_resp["authToken"]["X-aws-proxy-auth"]
upstream_base = f"https://{microvm_endpoint}"
local_base = f"http://127.0.0.1:{listen_port}"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


opener = urllib.request.build_opener(NoRedirect)


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _forward(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path or "/"
        if path == "/ui":
            path = "/ui/"
        query = parsed.query
        upstream = f"{upstream_base}{path}"
        if query:
            upstream = f"{upstream}?{query}"

        req_headers = {}
        for key, value in self.headers.items():
            lowered = key.lower()
            if lowered in {"host", "content-length", "connection", "x-aws-proxy-auth", "x-aws-proxy-port"}:
                continue
            req_headers[key] = value
        req_headers["X-aws-proxy-auth"] = proxy_auth_token
        req_headers["X-aws-proxy-port"] = str(microvm_port)

        body = None
        content_length = self.headers.get("Content-Length")
        if content_length:
            body = self.rfile.read(int(content_length))

        request = urllib.request.Request(url=upstream, data=body, method=self.command, headers=req_headers)
        try:
            with opener.open(request, timeout=30) as response:
                payload = response.read()
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() in {"transfer-encoding", "connection", "content-length"}:
                        continue
                    if key.lower() == "location":
                        value = value.replace(upstream_base, local_base)
                        value = value.replace(f"http://{microvm_endpoint}", local_base)
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as error:
            payload = error.read()
            self.send_response(error.code)
            if error.headers:
                for key, value in error.headers.items():
                    if key.lower() in {"transfer-encoding", "connection", "content-length"}:
                        continue
                    if key.lower() == "location":
                        value = value.replace(upstream_base, local_base)
                        value = value.replace(f"http://{microvm_endpoint}", local_base)
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as error:
            payload = str(error).encode("utf-8", errors="replace")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self) -> None:
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def do_PUT(self) -> None:
        self._forward()

    def do_PATCH(self) -> None:
        self._forward()

    def do_DELETE(self) -> None:
        self._forward()

    def do_OPTIONS(self) -> None:
        self._forward()

    def log_message(self, fmt: str, *args) -> None:
        return


print(f"MicroVM ID: {microvm_id}")
print(f"MicroVM endpoint: {microvm_endpoint}")
print(f"Local admin proxy: http://127.0.0.1:{listen_port}/ui")
print("Press Ctrl+C to stop.")
server = http.server.ThreadingHTTPServer(("127.0.0.1", listen_port), ProxyHandler)
server.serve_forever()
PY
