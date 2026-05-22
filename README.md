# LiteLLM Proxy Setup

A production-ready LiteLLM Proxy configuration supporting **Google Vertex AI (Gemini 3.5, 3.1, 3.0, 2.5)**, **AWS Bedrock (Nova + Minimax + Kimi)**, and **Azure OpenAI (GPT-5.2)** with PostgreSQL persistence and virtual key budgeting.

## 🚀 Quick Start

### 1. Prerequisites
*   **Docker & Docker Compose** installed.
*   **Google Cloud SDK (`gcloud`)** authenticated for Vertex AI:
    ```bash
    gcloud auth application-default login
    ```
*   **AWS Bedrock long-term API key** (for Bedrock models).
*   **Azure OpenAI API Key** and Resource Endpoint.

### 2. Configuration
Create the `.env` file with your actual credentials from `.env.template`.
#### Google Cloud Authentication
Execute the authentication command to set up your Google Cloud credentials:
```bash
gcloud auth application-default login
```

#### Azure OpenAI Setup
Ensure your Azure OpenAI API Key and Resource Endpoint are available for the `.env` configuration.

#### AWS Bedrock Setup (Long-term API Key)
Set your Bedrock long-term API key and AWS region in `.env`:

```bash
AWS_BEARER_TOKEN_BEDROCK=<YOUR_AWS_BEDROCK_LONG_TERM_API_KEY>
AWS_REGION=us-east-1
```

##### IAM policy required for Nova models
Create and attach an IAM policy to the IAM user/role that will generate and use the Bedrock long-term API key:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream"
            ],
            "Resource": [
                "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-lite-v1:0",
                "arn:aws:bedrock:us-east-1::foundation-model/minimax.minimax-m2.5",
                "arn:aws:bedrock:us-east-1::foundation-model/moonshotai.kimi-k2.5"
            ]
        },
        {
            "Effect": "Allow",
            "Action": "bedrock:CallWithBearerToken",
            "Resource": "*"
        }
    ]
}
```

After attaching this policy:
1. Create or rotate your Bedrock long-term API key from the same IAM principal.
2. Put that key into `AWS_BEARER_TOKEN_BEDROCK` in `.env`.
3. Restart the stack with `docker compose up -d` if it is already running.

If you are using `.env.template`, copy it first and then fill these fields:

```bash
cp .env.template .env
```

### 3. Deployment
```bash
docker compose up -d
```

### 4. Reset Everything
If you want to wipe the Docker state and start fresh, remove the stack and the named Postgres volume:

```bash
docker compose down -v --remove-orphans
docker compose up -d
```

---

## 🛠 Supported Models

| Model Alias | Provider | Underlying Model |
| :--- | :--- | :--- |
| **`gemini-3.5-flash`** | Vertex AI | `vertex_ai/gemini-3.5-flash` |
| **`gemini-3.1-flash-lite`** | Vertex AI | `vertex_ai/gemini-3.1-flash-lite` |
| **`gemini-3.1-flash-image-preview`** | Vertex AI | `vertex_ai/gemini-3.1-flash-image-preview` |
| **`gemini-3.1-pro-preview`** | Vertex AI | `vertex_ai/gemini-3.1-pro-preview` |
| **`gemini-3.1-pro-preview-customtools`** | Vertex AI | `vertex_ai/gemini-3.1-pro-preview` (with tools) |
| **`gemini-3-flash-preview`** | Vertex AI | `vertex_ai/gemini-3-flash-preview` |
| **`gemini-2.5-pro`** | Vertex AI | `vertex_ai/gemini-2.5-pro` |
| **`gemini-2.5-flash`** | Vertex AI | `vertex_ai/gemini-2.5-flash` |
| **`gemini-2.5-flash-lite`** | Vertex AI | `vertex_ai/gemini-2.5-flash-lite` |
| **`nova-2-lite`** | AWS Bedrock | `bedrock/global.amazon.nova-2-lite-v1:0` |
| **`minimax-m2.5`** | AWS Bedrock | `bedrock/minimax.minimax-m2.5` |
| **`kimi-k2.5`** | AWS Bedrock | `bedrock/moonshotai.kimi-k2.5` |
| **`gpt-5.2`** | Azure OpenAI | `azure/gpt-5.2` (with reasoning support) |

---

## 🔑 Key & Budget Management
Track spending and create virtual keys with PostgreSQL.

#### Generate a new key with a budget:
```bash
curl -X POST 'http://localhost:4000/key/generate' \
-H 'Authorization: Bearer <YOUR_MASTER_KEY>' \
-H 'Content-Type: application/json' \
-d "{
    \"key_alias\": \"user-key\",
    \"max_budget\": 10.00,
    \"budget_duration\": \"1d\"
}"
```


## Model Config in OpenClaw

```
  "models": {
    "mode": "merge",
    "providers": {
      "litellm": {
        "baseUrl": "http://<your proxy ip>:4000",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini-3.5-flash",
            "name": "gemini-3.5-flash",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 1048576,
            "maxTokens": 8192
          },
          {
            "id": "gemini-3.1-flash-lite",
            "name": "gemini-3.1-flash-lite",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "gpt-5.2",
            "name": "gpt-5.2",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "gemini-3.1-flash-image-preview",
            "name": "gemini-3.1-flash-image-preview",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "gemini-3.1-pro-preview",
            "name": "gemini-3.1-pro-preview",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 2097152,
            "maxTokens": 8192
          },
          {
            "id": "gemini-3.1-pro-preview-customtools",
            "name": "gemini-3.1-pro-preview-customtools",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 2097152,
            "maxTokens": 8192
          },
          {
            "id": "gemini-3-flash-preview",
            "name": "gemini-3-flash-preview",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 1048576,
            "maxTokens": 8192
          },
          {
            "id": "gemini-2.5-pro",
            "name": "gemini-2.5-pro",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 2097152,
            "maxTokens": 8192
          },
          {
            "id": "gemini-2.5-flash",
            "name": "gemini-2.5-flash",
            "reasoning": false,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 1048576,
            "maxTokens": 8192
          },
          {
            "id": "gemini-2.5-flash-lite",
            "name": "gemini-2.5-flash-lite",
            "reasoning": false,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 1048576,
            "maxTokens": 8192
          },
          {
            "id": "nova-2-lite",
            "name": "nova-2-lite",
            "reasoning": false,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 300000,
            "maxTokens": 8192
          },
          {
            "id": "minimax-m2.5",
            "name": "minimax-m2.5",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 300000,
            "maxTokens": 8192
          },
          {
            "id": "kimi-k2.5",
            "name": "kimi-k2.5",
            "reasoning": true,
            "input": [
              "text",
              "image"
            ],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 300000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
```

---

## 🧪 Testing
Run the included test script:
```bash
./test_litellm.sh
```
To test specific models, use `curl` or `openclaw models set litellm/<model-alias>`.
