import os

MODEL_PATH = os.path.join(os.path.dirname(__file__), "botocore_data")
existing_data_path = os.environ.get("AWS_DATA_PATH")
os.environ["AWS_DATA_PATH"] = MODEL_PATH if not existing_data_path else f"{MODEL_PATH}:{existing_data_path}"

import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

MICROVM_REGION = os.environ["MICROVM_REGION"]
_microvms = boto3.client("lambda-microvms", region_name=MICROVM_REGION)


def _matches_image(image_arn: str, image_identifier: str) -> bool:
    return image_arn == image_identifier or image_arn.endswith(f":microvm-image:{image_identifier}")


def _terminate_stack_microvms(microvm_identifier: str):
    paginator = _microvms.get_paginator("list_microvms")
    for page in paginator.paginate():
        for item in page.get("items", []):
            image_arn = str(item.get("imageArn") or "")
            if not _matches_image(image_arn, microvm_identifier):
                continue
            microvm_id = str(item.get("microvmId") or "")
            state = str(item.get("state") or "")
            if not microvm_id or state == "TERMINATED":
                continue
            try:
                _microvms.terminate_microvm(microvmIdentifier=microvm_id)
            except ClientError as error:
                code = (error.response.get("Error") or {}).get("Code")
                if code not in {"ResourceNotFoundException", "ValidationException"}:
                    raise


def _wait_for_no_running_microvms(microvm_identifier: str, attempts: int = 60, delay_seconds: int = 3):
    for _ in range(attempts):
        still_running = False
        paginator = _microvms.get_paginator("list_microvms")
        for page in paginator.paginate():
            for item in page.get("items", []):
                image_arn = str(item.get("imageArn") or "")
                if not _matches_image(image_arn, microvm_identifier):
                    continue
                if str(item.get("state") or "") not in {"TERMINATED", "TERMINATING"}:
                    still_running = True
                    break
            if still_running:
                break
        if not still_running:
            return
        import time

        time.sleep(delay_seconds)
    raise RuntimeError(f"Timed out waiting for MicroVM termination for image {microvm_identifier}.")


def handler(event, context):
    props = event.get("ResourceProperties") or {}
    old_props = event.get("OldResourceProperties") or {}
    microvm_identifier = str(props.get("MicrovmImageIdentifier") or "")
    public_microvm = str(props.get("PublicMicrovm") or "")
    if not microvm_identifier:
        raise RuntimeError("MicrovmImageIdentifier is required for cleanup custom resource.")

    request_type = event.get("RequestType")
    if request_type == "Delete":
        _terminate_stack_microvms(microvm_identifier)
        _wait_for_no_running_microvms(microvm_identifier)
    elif request_type == "Update":
        if public_microvm != str(old_props.get("PublicMicrovm") or ""):
            _terminate_stack_microvms(microvm_identifier)
            _wait_for_no_running_microvms(microvm_identifier)
    elif request_type != "Create":
        raise RuntimeError(f"Unsupported request type: {request_type}")

    physical_id = str(event.get("PhysicalResourceId") or "litellm-microvm-cleanup")
    return {"PhysicalResourceId": physical_id[:256]}
