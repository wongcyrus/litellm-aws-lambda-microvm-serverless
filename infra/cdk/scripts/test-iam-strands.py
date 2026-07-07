#!/usr/bin/env python3
"""
End-to-end IAM test using Strands Agents + OpenAI-compatible provider.

This validates:
1) AssumeRole credentials can call API Gateway /iam route with SigV4
2) LiteLLM key mapping is resolved from IAM principal
3) Chat completion succeeds through the IAM path
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials


@dataclass(frozen=True)
class AwsSessionCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str


class ExecuteApiSigV4Auth(httpx.Auth):
    def __init__(self, credentials: AwsSessionCredentials, region: str):
        self._credentials = Credentials(
            access_key=credentials.access_key_id,
            secret_key=credentials.secret_access_key,
            token=credentials.session_token,
        )
        self._region = region

    def auth_flow(self, request: httpx.Request):
        body = request.content if request.content is not None else b""
        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=body,
            headers=dict(request.headers),
        )
        SigV4Auth(self._credentials, "execute-api", self._region).add_auth(aws_request)
        request.headers.clear()
        for header_name, header_value in aws_request.headers.items():
            request.headers[header_name] = header_value
        yield request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test IAM /iam route with Strands")
    parser.add_argument("--api-url", required=True, help="API base URL, e.g. https://<id>.execute-api.us-east-1.amazonaws.com/prod/")
    parser.add_argument("--role-arn", required=True, help="IAM role ARN to assume before calling /iam route")
    parser.add_argument("--region", default="us-east-1", help="AWS region for STS + SigV4 signing")
    parser.add_argument("--session-duration-seconds", type=int, default=900, help="STS assume-role duration (900-43200)")
    parser.add_argument("--model", default="nova-2-lite", help="Model id (default: nova-2-lite)")
    parser.add_argument(
        "--prompt",
        default="Write 3 concise sentences about using LiteLLM with Amazon Bedrock in production, and include one practical reliability tip.",
        help="Prompt text",
    )
    parser.add_argument("--max-tokens", type=int, default=128, help="Max output tokens")
    parser.add_argument("--temperature", type=float, default=0.0, help="Sampling temperature")
    args = parser.parse_args()

    if not args.api_url.strip():
        raise SystemExit("Error: --api-url cannot be empty.")
    if not args.role_arn.strip():
        raise SystemExit("Error: --role-arn cannot be empty.")
    if args.session_duration_seconds < 900 or args.session_duration_seconds > 43200:
        raise SystemExit("Error: --session-duration-seconds must be between 900 and 43200.")
    return args


def assume_role(role_arn: str, region: str, duration_seconds: int) -> AwsSessionCredentials:
    sts = boto3.client("sts", region_name=region)
    resp = sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName=f"iam-strands-{int(time.time())}",
        DurationSeconds=duration_seconds,
    )
    creds = resp.get("Credentials") or {}
    access_key_id = str(creds.get("AccessKeyId") or "")
    secret_access_key = str(creds.get("SecretAccessKey") or "")
    session_token = str(creds.get("SessionToken") or "")
    if not access_key_id or not secret_access_key or not session_token:
        raise SystemExit("Error: assume-role returned incomplete credentials.")
    return AwsSessionCredentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=session_token,
    )


def normalize_base_url_for_iam(api_url: str) -> str:
    base = api_url.strip().rstrip("/")
    if not base:
        raise SystemExit("Error: --api-url cannot be empty.")
    return f"{base}/iam"


def health_check(iam_base_url: str, auth: ExecuteApiSigV4Auth) -> None:
    with httpx.Client(auth=auth, timeout=30.0) as client:
        response = client.get(f"{iam_base_url}/health/liveliness", headers={"accept": "application/json"})
    if response.status_code != 200:
        raise SystemExit(f"Error: IAM health check HTTP {response.status_code}: {response.text}")


def strands_chat(
    iam_base_url: str,
    model: str,
    prompt: str,
    max_tokens: int,
    temperature: float,
    auth: ExecuteApiSigV4Auth,
) -> str:
    try:
        from strands import Agent
        from strands.models.openai import OpenAIModel
    except Exception as exc:
        raise SystemExit(
            "Error: missing Strands OpenAI dependencies. Install with:\n"
            "  pip install 'strands-agents[openai]' strands-agents-tools"
        ) from exc

    async_client = httpx.AsyncClient(auth=auth, timeout=60.0)
    openai_model = OpenAIModel(
        client_args={
            "api_key": "iam-auth",
            "base_url": iam_base_url,
            "http_client": async_client,
        },
        model_id=model,
        params={"max_tokens": max_tokens, "temperature": temperature},
    )
    agent = Agent(model=openai_model, callback_handler=None)
    result = agent(prompt)
    text = str(result).strip()
    if not text:
        raise SystemExit("Error: Strands call returned empty response.")
    return text


def main() -> int:
    args = parse_args()
    credentials = assume_role(args.role_arn.strip(), args.region, args.session_duration_seconds)
    iam_base_url = normalize_base_url_for_iam(args.api_url)
    sigv4_auth = ExecuteApiSigV4Auth(credentials, args.region)
    health_check(iam_base_url, sigv4_auth)
    output = strands_chat(
        iam_base_url=iam_base_url,
        model=args.model,
        prompt=args.prompt,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        auth=sigv4_auth,
    )

    print(
        json.dumps(
            {
                "status": "ok",
                "model": args.model,
                "role_arn": args.role_arn,
                "iam_base_url": iam_base_url,
                "response": output,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
