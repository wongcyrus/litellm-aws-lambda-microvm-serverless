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


def handler(event, context):
    props = event.get("ResourceProperties") or {}
    microvm_identifier = str(props.get("MicrovmImageIdentifier") or "")
    if not microvm_identifier:
        raise RuntimeError("MicrovmImageIdentifier is required for cleanup custom resource.")

    if event.get("RequestType") == "Delete":
        _terminate_stack_microvms(microvm_identifier)

    physical_id = str(event.get("PhysicalResourceId") or "litellm-microvm-cleanup")
    return {"PhysicalResourceId": physical_id[:256]}
