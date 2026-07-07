import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

MODEL_PATH = os.path.join(os.path.dirname(__file__), "botocore_data")
existing_data_path = os.environ.get("AWS_DATA_PATH")
os.environ["AWS_DATA_PATH"] = MODEL_PATH if not existing_data_path else f"{MODEL_PATH}:{existing_data_path}"

import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

MICROVM_REGION = os.environ["MICROVM_REGION"]
MICROVM_PORT = os.environ.get("MICROVM_PORT", "4000")
TOKEN_EXPIRATION_MINUTES = int(os.environ.get("TOKEN_EXPIRATION_MINUTES", "60"))
TOKEN_REFRESH_MARGIN_SECONDS = 120

MICROVM_IMAGE_IDENTIFIER = os.environ["MICROVM_IMAGE_IDENTIFIER"]
MICROVM_EXECUTION_ROLE_ARN = os.environ["MICROVM_EXECUTION_ROLE_ARN"]
MICROVM_INGRESS_CONNECTOR_ARN = os.environ.get(
    "MICROVM_INGRESS_CONNECTOR_ARN",
    f"arn:aws:lambda:{MICROVM_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS",
)
MICROVM_EGRESS_CONNECTOR_ARN = os.environ.get("MICROVM_EGRESS_CONNECTOR_ARN")
MICROVM_IMAGE_VERSION = os.environ.get("MICROVM_IMAGE_VERSION")

_client = boto3.client("lambda-microvms", region_name=MICROVM_REGION)
_core_client = boto3.client("lambda-core", region_name=MICROVM_REGION)
_cache: dict[str, Any] = {
    "token": None,
    "token_expires_at": 0.0,
    "token_microvm_id": None,
    "microvm_id": None,
    "microvm_endpoint": None,
    "egress_connector_arn": None,
}

NETWORK_CONNECTOR_NAME = os.environ.get("NETWORK_CONNECTOR_NAME", "litellm-db-egress")
NETWORK_CONNECTOR_SUBNET_IDS = [item for item in os.environ.get("NETWORK_CONNECTOR_SUBNET_IDS", "").split(",") if item]
NETWORK_CONNECTOR_SECURITY_GROUP_IDS = [
    item for item in os.environ.get("NETWORK_CONNECTOR_SECURITY_GROUP_IDS", "").split(",") if item
]
NETWORK_CONNECTOR_OPERATOR_ROLE_ARN = os.environ.get("NETWORK_CONNECTOR_OPERATOR_ROLE_ARN")
PROXY_CACHE_TABLE_NAME = os.environ.get("PROXY_CACHE_TABLE_NAME")
IAM_KEY_MAP_TABLE_NAME = os.environ.get("IAM_KEY_MAP_TABLE_NAME")
IAM_ROUTE_PREFIX = os.environ.get("IAM_ROUTE_PREFIX", "/iam")
MICROVM_MAX_DURATION_SECONDS = 28800
MICROVM_CACHE_KEY = "microvm-proxy-state"

_dynamodb = boto3.client("dynamodb", region_name=MICROVM_REGION) if PROXY_CACHE_TABLE_NAME else None

if not IAM_ROUTE_PREFIX.startswith("/"):
    IAM_ROUTE_PREFIX = "/" + IAM_ROUTE_PREFIX


class UnauthorizedPrincipalError(Exception):
    pass


def _assumed_role_arn_to_role_arn(principal_arn: str) -> str | None:
    parts = principal_arn.split(":", 5)
    if len(parts) != 6:
        return None
    arn_prefix, partition, service, _, account_id, resource = parts
    if arn_prefix != "arn" or service != "sts":
        return None
    if not resource.startswith("assumed-role/"):
        return None

    resource_parts = resource.split("/")
    if len(resource_parts) < 3:
        return None
    role_name = "/".join(resource_parts[1:-1]).strip()
    if not role_name:
        return None
    return f"arn:{partition}:iam::{account_id}:role/{role_name}"


def _load_cache_from_dynamodb() -> None:
    if _cache.get("dynamodb_loaded"):
        return
    _cache["dynamodb_loaded"] = True
    if not _dynamodb or not PROXY_CACHE_TABLE_NAME:
        return

    response = _dynamodb.get_item(
        TableName=PROXY_CACHE_TABLE_NAME,
        Key={"pk": {"S": MICROVM_CACHE_KEY}},
        ConsistentRead=False,
    )
    item = response.get("Item")
    if not item:
        return

    now = time.time()
    token_expires_at = float(item.get("token_expires_at", {}).get("N", "0") or 0)
    if token_expires_at > now:
        token = item.get("token", {}).get("S")
        token_microvm_id = item.get("token_microvm_id", {}).get("S")
        if token and token_microvm_id:
            _cache["token"] = token
            _cache["token_expires_at"] = token_expires_at
            _cache["token_microvm_id"] = token_microvm_id

    microvm_expires_at = float(item.get("microvm_expires_at", {}).get("N", "0") or 0)
    if microvm_expires_at > now:
        microvm_id = item.get("microvm_id", {}).get("S")
        microvm_endpoint = item.get("microvm_endpoint", {}).get("S")
        if microvm_id and microvm_endpoint:
            _cache["microvm_id"] = microvm_id
            _cache["microvm_endpoint"] = microvm_endpoint
            _cache["microvm_expires_at"] = microvm_expires_at

    egress_connector_arn = item.get("egress_connector_arn", {}).get("S")
    if egress_connector_arn:
        _cache["egress_connector_arn"] = egress_connector_arn


def _persist_cache_to_dynamodb() -> None:
    if not _dynamodb or not PROXY_CACHE_TABLE_NAME:
        return

    now = int(time.time())
    token_expires_at = int(float(_cache.get("token_expires_at") or 0))
    microvm_expires_at = int(float(_cache.get("microvm_expires_at") or 0))
    ttl_expires_at = max(now + 300, token_expires_at, microvm_expires_at)

    item: dict[str, Any] = {"pk": {"S": MICROVM_CACHE_KEY}, "expires_at": {"N": str(ttl_expires_at)}}
    if _cache.get("token"):
        item["token"] = {"S": str(_cache["token"])}
    if _cache.get("token_microvm_id"):
        item["token_microvm_id"] = {"S": str(_cache["token_microvm_id"])}
    if token_expires_at > 0:
        item["token_expires_at"] = {"N": str(token_expires_at)}
    if _cache.get("microvm_id"):
        item["microvm_id"] = {"S": str(_cache["microvm_id"])}
    if _cache.get("microvm_endpoint"):
        item["microvm_endpoint"] = {"S": str(_cache["microvm_endpoint"])}
    if microvm_expires_at > 0:
        item["microvm_expires_at"] = {"N": str(microvm_expires_at)}
    if _cache.get("egress_connector_arn"):
        item["egress_connector_arn"] = {"S": str(_cache["egress_connector_arn"])}

    _dynamodb.put_item(TableName=PROXY_CACHE_TABLE_NAME, Item=item)


def _invalidate_cached_token() -> None:
    _cache["token"] = None
    _cache["token_expires_at"] = 0.0
    _cache["token_microvm_id"] = None


def _set_active_microvm(microvm_id: str, endpoint: str) -> None:
    if str(_cache.get("microvm_id") or "") != str(microvm_id):
        _invalidate_cached_token()
    _cache["microvm_id"] = microvm_id
    _cache["microvm_endpoint"] = endpoint
    _cache["microvm_expires_at"] = time.time() + MICROVM_MAX_DURATION_SECONDS
    _persist_cache_to_dynamodb()


def _ensure_vpc_egress_connector() -> str | None:
    _load_cache_from_dynamodb()
    if MICROVM_EGRESS_CONNECTOR_ARN:
        return MICROVM_EGRESS_CONNECTOR_ARN

    if not NETWORK_CONNECTOR_SUBNET_IDS or not NETWORK_CONNECTOR_SECURITY_GROUP_IDS or not NETWORK_CONNECTOR_OPERATOR_ROLE_ARN:
        return None

    cached_arn = _cache.get("egress_connector_arn")
    if cached_arn:
        return str(cached_arn)

    paginator = _core_client.get_paginator("list_network_connectors")
    for page in paginator.paginate():
        for item in page.get("NetworkConnectors", []):
            if item.get("Name") == NETWORK_CONNECTOR_NAME:
                arn = item["Arn"]
                state = item.get("State")
                if state != "ACTIVE":
                    for _ in range(60):
                        detail = _core_client.get_network_connector(Identifier=arn)
                        state = detail.get("State")
                        if state == "ACTIVE":
                            break
                        if state in {"FAILED", "DELETE_FAILED"}:
                            raise RuntimeError(f"Network connector failed: {detail.get('StateReason', 'unknown')}")
                        time.sleep(1)
                    if state != "ACTIVE":
                        raise RuntimeError("Timed out waiting for network connector to become ACTIVE")
                _cache["egress_connector_arn"] = arn
                _persist_cache_to_dynamodb()
                return arn

    create_resp = _core_client.create_network_connector(
        Name=NETWORK_CONNECTOR_NAME,
        Configuration={
            "VpcEgressConfiguration": {
                "SubnetIds": NETWORK_CONNECTOR_SUBNET_IDS,
                "SecurityGroupIds": NETWORK_CONNECTOR_SECURITY_GROUP_IDS,
                "NetworkProtocol": "IPv4",
                "AssociatedComputeResourceTypes": ["MicroVm"],
            }
        },
        OperatorRole=NETWORK_CONNECTOR_OPERATOR_ROLE_ARN,
    )
    arn = create_resp["Arn"]
    for _ in range(90):
        detail = _core_client.get_network_connector(Identifier=arn)
        state = detail.get("State")
        if state == "ACTIVE":
            _cache["egress_connector_arn"] = arn
            _persist_cache_to_dynamodb()
            return arn
        if state in {"FAILED", "DELETE_FAILED"}:
            raise RuntimeError(f"Network connector failed: {detail.get('StateReason', 'unknown')}")
        time.sleep(1)
    raise RuntimeError("Timed out waiting for created network connector to become ACTIVE")


def _ensure_running_microvm() -> tuple[str, str]:
    _load_cache_from_dynamodb()
    image_detail = _client.get_microvm_image(imageIdentifier=MICROVM_IMAGE_IDENTIFIER)
    latest_image_version = str(image_detail.get("latestActiveImageVersion") or "")

    def matches_image_identifier(image_arn: str) -> bool:
        if MICROVM_IMAGE_IDENTIFIER.startswith("arn:aws:lambda:"):
            return image_arn == MICROVM_IMAGE_IDENTIFIER
        return image_arn.endswith(f":microvm-image:{MICROVM_IMAGE_IDENTIFIER}")

    def matches_latest_image_version(image_version: Any) -> bool:
        if not latest_image_version:
            return True
        return str(image_version or "") == latest_image_version

    def matches_required_egress(detail: dict[str, Any]) -> bool:
        if not MICROVM_EGRESS_CONNECTOR_ARN:
            return True
        egress_connectors = detail.get("egressNetworkConnectors") or []
        return MICROVM_EGRESS_CONNECTOR_ARN in egress_connectors

    cached_id = _cache.get("microvm_id")
    cached_endpoint = _cache.get("microvm_endpoint")
    if cached_id and cached_endpoint:
        try:
            detail = _client.get_microvm(microvmIdentifier=str(cached_id))
            state = detail["state"]
            if state == "RUNNING" and matches_required_egress(detail) and matches_latest_image_version(detail.get("imageVersion")):
                return str(cached_id), str(cached_endpoint)
        except ClientError:
            _invalidate_cached_token()

    paginator = _client.get_paginator("list_microvms")
    for page in paginator.paginate():
        for item in page.get("items", []):
            if matches_image_identifier(item.get("imageArn", "")) and item.get("state") == "RUNNING":
                microvm_id = item["microvmId"]
                if not matches_latest_image_version(item.get("imageVersion")):
                    _client.terminate_microvm(microvmIdentifier=microvm_id)
                    continue
                detail = _client.get_microvm(microvmIdentifier=microvm_id)
                if not matches_required_egress(detail):
                    _client.terminate_microvm(microvmIdentifier=microvm_id)
                    continue
                endpoint = detail["endpoint"]
                _set_active_microvm(str(microvm_id), str(endpoint))
                return microvm_id, endpoint

    run_args: dict[str, Any] = {
        "imageIdentifier": MICROVM_IMAGE_IDENTIFIER,
        "executionRoleArn": MICROVM_EXECUTION_ROLE_ARN,
        "ingressNetworkConnectors": [MICROVM_INGRESS_CONNECTOR_ARN],
        "idlePolicy": {
            "autoResumeEnabled": True,
            "maxIdleDurationSeconds": 900,
            "suspendedDurationSeconds": 28800,
        },
        "maximumDurationInSeconds": 28800,
    }
    if MICROVM_IMAGE_VERSION:
        run_args["imageVersion"] = MICROVM_IMAGE_VERSION
    elif latest_image_version:
        run_args["imageVersion"] = latest_image_version
    egress_connector_arn = _ensure_vpc_egress_connector()
    if egress_connector_arn and egress_connector_arn != MICROVM_EGRESS_CONNECTOR_ARN:
        raise RuntimeError("Resolved VPC egress connector does not match MICROVM_EGRESS_CONNECTOR_ARN")
    if egress_connector_arn:
        run_args["egressNetworkConnectors"] = [egress_connector_arn]

    run_resp = _client.run_microvm(**run_args)
    microvm_id = run_resp["microvmId"]

    for _ in range(60):
        detail = _client.get_microvm(microvmIdentifier=microvm_id)
        state = detail["state"]
        if state == "RUNNING":
            endpoint = detail["endpoint"]
            _set_active_microvm(str(microvm_id), str(endpoint))
            return microvm_id, endpoint
        if state in {"TERMINATED", "TERMINATING"}:
            raise RuntimeError(f"MicroVM terminated during startup: {detail.get('stateReason', 'unknown')}")
        time.sleep(1)

    raise RuntimeError("Timed out waiting for MicroVM to become RUNNING")


def _create_microvm_auth_token(microvm_id: str) -> str:
    _load_cache_from_dynamodb()
    now = time.time()
    cached_token = _cache.get("token")
    expires_at = float(_cache.get("token_expires_at") or 0)
    token_microvm_id = str(_cache.get("token_microvm_id") or "")
    if cached_token and token_microvm_id == microvm_id and now < (expires_at - TOKEN_REFRESH_MARGIN_SECONDS):
        return str(cached_token)

    resp = _client.create_microvm_auth_token(
        microvmIdentifier=microvm_id,
        expirationInMinutes=TOKEN_EXPIRATION_MINUTES,
        allowedPorts=[{"port": int(MICROVM_PORT)}],
    )
    token = resp["authToken"]["X-aws-proxy-auth"]
    _cache["token"] = token
    _cache["token_expires_at"] = now + (TOKEN_EXPIRATION_MINUTES * 60)
    _cache["token_microvm_id"] = microvm_id
    _persist_cache_to_dynamodb()
    return str(token)


def _forward_to_microvm(event: dict) -> dict:
    microvm_id, microvm_endpoint = _ensure_running_microvm()
    method = event.get("httpMethod", "GET")
    request_path = str(event.get("path", "/") or "/")
    if not request_path.startswith("/"):
        request_path = "/" + request_path
    is_iam_path = request_path == IAM_ROUTE_PREFIX or request_path.startswith(f"{IAM_ROUTE_PREFIX}/")
    upstream_path = request_path
    if is_iam_path:
        stripped = request_path[len(IAM_ROUTE_PREFIX) :]
        upstream_path = stripped if stripped.startswith("/") else f"/{stripped}"
        if not upstream_path:
            upstream_path = "/"

    query = event.get("queryStringParameters") or {}
    query_string = urllib.parse.urlencode(query, doseq=True)
    url = f"https://{microvm_endpoint}{upstream_path}"
    if query_string:
        url = f"{url}?{query_string}"

    raw_headers = event.get("headers") or {}
    forwarded_headers = {str(k): str(v) for k, v in raw_headers.items() if v is not None}
    for blocked_header in [
        "host",
        "connection",
        "content-length",
        "accept-encoding",
        "transfer-encoding",
        "x-amzn-trace-id",
        "x-aws-proxy-auth",
        "x-aws-proxy-port",
    ]:
        forwarded_headers.pop(blocked_header, None)
        forwarded_headers.pop(blocked_header.title(), None)

    def pop_header_case_insensitive(name: str) -> None:
        for existing_key in [k for k in forwarded_headers.keys() if k.lower() == name.lower()]:
            forwarded_headers.pop(existing_key, None)

    if is_iam_path:
        if not _dynamodb or not IAM_KEY_MAP_TABLE_NAME:
            raise UnauthorizedPrincipalError("IAM route mapping table is not configured.")
        request_context = event.get("requestContext") or {}
        identity = request_context.get("identity") or {}
        principal_arn = str(identity.get("userArn") or "")
        if not principal_arn:
            raise UnauthorizedPrincipalError("Missing IAM principal ARN on request context.")

        principal_candidates = [principal_arn]
        normalized_role_arn = _assumed_role_arn_to_role_arn(principal_arn)
        if normalized_role_arn and normalized_role_arn not in principal_candidates:
            principal_candidates.append(normalized_role_arn)

        mapping = None
        for candidate in principal_candidates:
            mapping = _dynamodb.get_item(
                TableName=IAM_KEY_MAP_TABLE_NAME,
                Key={"principal_arn": {"S": candidate}},
                ConsistentRead=True,
            ).get("Item")
            if mapping:
                break

        litellm_key = str((mapping or {}).get("litellm_key", {}).get("S") or "")
        if not litellm_key:
            raise UnauthorizedPrincipalError(f"No LiteLLM key mapping found for IAM principal: {principal_arn}")

        for key_header in [
            "authorization",
            "x-api-key",
            "api-key",
            "x-goog-api-key",
            "ocp-apim-subscription-key",
            "x-litellm-api-key",
        ]:
            pop_header_case_insensitive(key_header)
        forwarded_headers["Authorization"] = f"Bearer {litellm_key}"

    # For key-management endpoints, authenticate to LiteLLM only via Authorization
    # (master key). Keep API Gateway key at the gateway layer and avoid passing it
    # through to app auth, which can conflict with master-key auth on /key/* routes.
    if not is_iam_path and (request_path == "/key/generate" or request_path.startswith("/key/")):
        for key_header in [
            "x-api-key",
            "api-key",
            "x-goog-api-key",
            "ocp-apim-subscription-key",
            "x-litellm-api-key",
        ]:
            pop_header_case_insensitive(key_header)

    forwarded_headers["X-aws-proxy-auth"] = _create_microvm_auth_token(microvm_id)
    forwarded_headers["X-aws-proxy-port"] = MICROVM_PORT

    body = event.get("body")
    request_body = None
    if body is not None:
        if event.get("isBase64Encoded", False):
            request_body = base64.b64decode(body)
        else:
            request_body = body.encode("utf-8")

    request = urllib.request.Request(
        url=url,
        data=request_body,
        headers=forwarded_headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_bytes = response.read()
            response_headers = dict(response.headers.items())
            content_type = str(response_headers.get("content-type") or response_headers.get("Content-Type") or "")
            lowered_content_type = content_type.lower()
            is_text_response = (
                lowered_content_type.startswith("text/")
                or "json" in lowered_content_type
                or "javascript" in lowered_content_type
                or "xml" in lowered_content_type
                or "svg" in lowered_content_type
            )
            if is_text_response:
                response_body = response_bytes.decode("utf-8", errors="replace")
                is_base64_encoded = False
            else:
                response_body = base64.b64encode(response_bytes).decode("ascii")
                is_base64_encoded = True

            for header_name in ["content-length", "Content-Length", "transfer-encoding", "Transfer-Encoding"]:
                response_headers.pop(header_name, None)

            return {
                "statusCode": response.status,
                "isBase64Encoded": is_base64_encoded,
                "headers": response_headers,
                "body": response_body,
            }
    except urllib.error.HTTPError as error:
        error_body = error.read()
        error_headers = dict(error.headers.items()) if error.headers else {}
        error_content_type = str(error_headers.get("content-type") or error_headers.get("Content-Type") or "")
        lowered_error_content_type = error_content_type.lower()
        is_text_error = (
            lowered_error_content_type.startswith("text/")
            or "json" in lowered_error_content_type
            or "javascript" in lowered_error_content_type
            or "xml" in lowered_error_content_type
            or "svg" in lowered_error_content_type
        )
        if is_text_error:
            response_body = error_body.decode("utf-8", errors="replace")
            is_base64_encoded = False
        else:
            response_body = base64.b64encode(error_body).decode("ascii")
            is_base64_encoded = True

        for header_name in ["content-length", "Content-Length", "transfer-encoding", "Transfer-Encoding"]:
            error_headers.pop(header_name, None)

        return {
            "statusCode": error.code,
            "isBase64Encoded": is_base64_encoded,
            "headers": error_headers,
            "body": response_body,
        }


def handler(event, context):
    try:
        return _forward_to_microvm(event)
    except UnauthorizedPrincipalError as error:
        return {
            "statusCode": 403,
            "isBase64Encoded": False,
            "headers": {"content-type": "application/json"},
            "body": json.dumps({"error": {"message": str(error), "type": "auth_error", "code": "forbidden"}}),
        }
