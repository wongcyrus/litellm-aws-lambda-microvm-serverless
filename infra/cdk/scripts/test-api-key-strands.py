#!/usr/bin/env python3
"""
End-to-end key test using Strands Agents + OpenAI-compatible provider.

This validates:
1) API Gateway accepts x-api-key
2) LiteLLM accepts Authorization bearer key
3) Chat completion succeeds through the deployed endpoint
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test LiteLLM API key with Strands")
    parser.add_argument("--api-url", required=True, help="API base URL, e.g. https://<id>.execute-api.us-east-1.amazonaws.com/prod/")
    parser.add_argument("--api-key", help="Key value (sk-...)")
    parser.add_argument("--api-key-file", help="Path to file containing key")
    parser.add_argument("--model", default="nova-2-lite", help="Model id (default: nova-2-lite)")
    parser.add_argument(
        "--prompt",
        default="Write 3 concise sentences about using LiteLLM with Amazon Bedrock in production, and include one practical reliability tip.",
        help="Prompt text",
    )
    parser.add_argument("--max-tokens", type=int, default=128, help="Max output tokens")
    parser.add_argument("--temperature", type=float, default=0.0, help="Sampling temperature")
    args = parser.parse_args()

    if bool(args.api_key) == bool(args.api_key_file):
        raise SystemExit("Error: provide exactly one of --api-key or --api-key-file.")
    return args


def load_key(args: argparse.Namespace) -> str:
    if args.api_key:
        key = args.api_key.strip()
    else:
        with open(args.api_key_file, "r", encoding="utf-8") as f:
            key = f.read().strip()
    if not key:
        raise SystemExit("Error: resolved empty key.")
    return key


def normalize_api_url(api_url: str) -> str:
    api_url = api_url.strip()
    if not api_url:
        raise SystemExit("Error: --api-url cannot be empty.")
    return api_url.rstrip("/")


def health_check(api_url: str, key: str) -> None:
    req = urllib.request.Request(
        f"{api_url}/health/liveliness",
        headers={
            "x-api-key": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status != 200:
                raise SystemExit(f"Error: health check HTTP {resp.status}: {body}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Error: health check HTTP {exc.code}: {body}") from exc


def strands_chat(api_url: str, key: str, model: str, prompt: str, max_tokens: int, temperature: float) -> str:
    try:
        from strands import Agent
        from strands.models.openai import OpenAIModel
    except Exception as exc:
        raise SystemExit(
            "Error: missing Strands OpenAI dependencies. Install with:\n"
            "  pip install 'strands-agents[openai]' strands-agents-tools"
        ) from exc

    openai_model = OpenAIModel(
        client_args={
            "api_key": key,
            "base_url": api_url,
            "default_headers": {"x-api-key": key},
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
    key = load_key(args)
    api_url = normalize_api_url(args.api_url)

    health_check(api_url, key)
    output = strands_chat(api_url, key, args.model, args.prompt, args.max_tokens, args.temperature)

    print(json.dumps({"status": "ok", "model": args.model, "response": output}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
