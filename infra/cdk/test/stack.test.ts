import test from "node:test";
import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { PrivateLiteLlmMicrovmStack } from "../lib/private-litellm-microvm-stack";

test("synthesizes PrivateLiteLlmMicrovmStack with publicMicrovm=true", () => {
  const app = new cdk.App();
  const stack = new PrivateLiteLlmMicrovmStack(app, "TestStackPublic", {
    env: { account: "123456789012", region: "us-east-1" },
    microvmRegion: "us-east-1",
    useCodebuildEcrBaseImage: false,
    readinessCheckNonce: "nonce-1",
    publicMicrovm: true,
  });

  const template = Template.fromStack(stack);

  // Core resources
  template.resourceCountIs("AWS::EC2::VPC", 1);
  template.resourceCountIs("AWS::RDS::DBCluster", 1);
  template.resourceCountIs("AWS::DynamoDB::Table", 2);
  template.resourceCountIs("AWS::ApiGateway::RestApi", 1);

  // Check expected outputs
  template.hasOutput("MicrovmAuthProxyFunctionName", {});
  template.hasOutput("MicrovmEgressConnectorArn", {});
  template.hasOutput("PublicApiInvokeUrl", {});
  template.hasOutput("LiteLlmMasterKeySecretArn", {});
});

test("synthesizes PrivateLiteLlmMicrovmStack with publicMicrovm=false", () => {
  const app = new cdk.App();
  const stack = new PrivateLiteLlmMicrovmStack(app, "TestStackPrivate", {
    env: { account: "123456789012", region: "us-east-1" },
    microvmRegion: "us-east-1",
    useCodebuildEcrBaseImage: false,
    readinessCheckNonce: "nonce-2",
    publicMicrovm: false,
  });

  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::EC2::VPC", 1);
  template.resourceCountIs("AWS::RDS::DBCluster", 1);
});

test("synthesizes PrivateLiteLlmMicrovmStack with Azure and Vertex providers and CodeBuild mirror", () => {
  process.env.CDK_DEFAULT_ACCOUNT = "123456789012";
  const app = new cdk.App();
  const stack = new PrivateLiteLlmMicrovmStack(app, "TestStackMultiProvider", {
    env: { account: "123456789012", region: "us-east-1" },
    microvmRegion: "us-east-1",
    useCodebuildEcrBaseImage: true,
    readinessCheckNonce: "nonce-3",
    publicMicrovm: true,
    azureApiBase: "https://my-azure.openai.azure.com",
    azureApiKey: "test-azure-key",
    vertexAiProject: "test-gcp-project",
    vertexAiLocation: "us-central1",
    vertexCredentialsJson: JSON.stringify({ type: "service_account" }),
  });

  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::CodeBuild::Project", 1);
  template.resourceCountIs("AWS::ECR::Repository", 1);
});
