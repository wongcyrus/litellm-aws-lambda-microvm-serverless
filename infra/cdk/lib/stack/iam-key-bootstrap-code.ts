export const IAM_KEY_BOOTSTRAP_INLINE_CODE = `
import base64
import hashlib
import json
import secrets
import string
import time

import boto3

lambda_client = boto3.client("lambda")
secrets_client = boto3.client("secretsmanager")
ddb = boto3.client("dynamodb")


def _master_key_from_secret(secret_arn: str) -> str:
    payload = secrets_client.get_secret_value(SecretId=secret_arn)["SecretString"]
    obj = json.loads(payload)
    prefix = str(obj.get("prefix") or "")
    suffix = str(obj.get("suffix") or "")
    if not prefix or not suffix:
        raise RuntimeError("Master key secret JSON must contain prefix and suffix.")
    return prefix + suffix


def _generate_key() -> str:
    chars = string.ascii_letters + string.digits
    return "sk-" + "".join(secrets.choice(chars) for _ in range(45))


def _get_existing_mapping(table_name: str, principal_arn: str) -> dict | None:
    item = ddb.get_item(
        TableName=table_name,
        Key={"principal_arn": {"S": principal_arn}},
        ConsistentRead=True,
    ).get("Item")
    return item if item else None


def _invoke_key_generate(
    proxy_function_name: str,
    master_key: str,
    key_alias: str,
    key_value: str,
    duration: str,
    key_type: str,
):
    body = {
        "key_alias": key_alias,
        "key": key_value,
        "key_type": key_type,
        "metadata": {"owner": "cdk-custom-resource"},
    }
    if duration:
        body["duration"] = duration
    event = {
        "httpMethod": "POST",
        "path": "/key/generate",
        "headers": {
            "Authorization": f"Bearer {master_key}",
            "Content-Type": "application/json",
        },
        "queryStringParameters": None,
        "body": json.dumps(body),
        "isBase64Encoded": False,
    }
    invoke_resp = lambda_client.invoke(
        FunctionName=proxy_function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(event).encode("utf-8"),
    )
    payload = invoke_resp["Payload"].read().decode("utf-8") or "{}"
    result = json.loads(payload)
    status_code = int(result.get("statusCode") or 0)
    body = str(result.get("body") or "")
    if result.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8", errors="replace")
    if status_code != 200:
        raise RuntimeError(f"/key/generate failed: status={status_code} body={body}")
    body_json = json.loads(body)
    returned_key = body_json.get("key") or body_json.get("token")
    if returned_key != key_value:
        raise RuntimeError("LiteLLM returned a different key than requested.")


def _wait_until_litellm_ready(proxy_function_name: str, max_attempts: int = 60, delay_seconds: int = 2) -> None:
    event = {
        "httpMethod": "GET",
        "path": "/health/liveliness",
        "headers": {},
        "queryStringParameters": None,
        "body": None,
        "isBase64Encoded": False,
    }
    last_status = 0
    for _ in range(max_attempts):
        invoke_resp = lambda_client.invoke(
            FunctionName=proxy_function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(event).encode("utf-8"),
        )
        payload = invoke_resp["Payload"].read().decode("utf-8") or "{}"
        result = json.loads(payload)
        last_status = int(result.get("statusCode") or 0)
        if last_status == 200:
            return
        time.sleep(delay_seconds)
    raise RuntimeError(f"LiteLLM not ready for key bootstrap. lastStatus={last_status}")


def handler(event, context):
    props = event.get("ResourceProperties") or {}
    old_props = event.get("OldResourceProperties") or {}
    principal_arn = str(props.get("PrincipalArn") or "")
    table_name = str(props.get("TableName") or "")
    proxy_function_name = str(props.get("ProxyFunctionName") or "")
    master_key_secret_arn = str(props.get("MasterKeySecretArn") or "")
    key_alias = str(props.get("KeyAlias") or "")
    duration = str(props.get("Duration") or "")
    key_type = str(props.get("KeyType") or "llm_api")
    if not principal_arn or not table_name or not proxy_function_name or not master_key_secret_arn or not key_alias:
        raise RuntimeError("Missing required custom resource properties.")

    physical_id = event.get("PhysicalResourceId") or f"iam-key-map-{hashlib.sha256(principal_arn.encode('utf-8')).hexdigest()[:16]}"
    request_type = event.get("RequestType")
    if request_type not in {"Create", "Update", "Delete"}:
        raise RuntimeError(f"Unsupported request type: {request_type}")

    old_principal_arn = str(old_props.get("PrincipalArn") or "")
    old_table_name = str(old_props.get("TableName") or table_name)

    if request_type == "Delete":
        ddb.delete_item(TableName=table_name, Key={"principal_arn": {"S": principal_arn}})
        if old_principal_arn and old_principal_arn != principal_arn:
            ddb.delete_item(TableName=old_table_name, Key={"principal_arn": {"S": old_principal_arn}})
        return {"PhysicalResourceId": physical_id}

    if request_type == "Update" and old_principal_arn and old_principal_arn != principal_arn:
        ddb.delete_item(TableName=old_table_name, Key={"principal_arn": {"S": old_principal_arn}})

    existing = _get_existing_mapping(table_name, principal_arn)
    existing_alias = ""
    existing_key = ""
    existing_key_type = ""
    if existing:
        existing_alias = str(existing.get("key_alias", {}).get("S") or "")
        existing_key = str(existing.get("litellm_key", {}).get("S") or "")
        existing_key_type = str(existing.get("key_type", {}).get("S") or "")
        if existing_alias == key_alias and existing_key and existing_key_type == key_type:
            return {"PhysicalResourceId": physical_id}

    if request_type in {"Create", "Update"}:
        _wait_until_litellm_ready(proxy_function_name)
        master_key = _master_key_from_secret(master_key_secret_arn)
        generated_key = _generate_key()
        _invoke_key_generate(proxy_function_name, master_key, key_alias, generated_key, duration, key_type)
        ddb.put_item(
            TableName=table_name,
            Item={
                "principal_arn": {"S": principal_arn},
                "litellm_key": {"S": generated_key},
                "key_alias": {"S": key_alias},
                "key_type": {"S": key_type},
            },
        )
    return {"PhysicalResourceId": physical_id}
`;
