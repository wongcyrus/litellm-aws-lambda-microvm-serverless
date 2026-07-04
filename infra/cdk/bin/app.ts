#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { PrivateLiteLlmMicrovmStack } from "../lib/private-litellm-microvm-stack";

const app = new cdk.App();

const microvmRegion = app.node.tryGetContext("microvmRegion") ?? process.env.CDK_DEFAULT_REGION;
const microvmArtifactKey = app.node.tryGetContext("microvmArtifactKey");
const apiGatewayApiKeyValue = app.node.tryGetContext("apiGatewayApiKeyValue");
const microvmEgressConnectorArn = app.node.tryGetContext("microvmEgressConnectorArn");
const publicMicrovmContext = app.node.tryGetContext("publicMicrovm");
const publicMicrovm = publicMicrovmContext === undefined ? true : String(publicMicrovmContext).toLowerCase() === "true";
const microvmDeployPhase = String(app.node.tryGetContext("microvmDeployPhase") ?? "runtime").toLowerCase();
const internetEgressConnectorArn = `arn:aws:lambda:${microvmRegion}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

if (!microvmRegion || !apiGatewayApiKeyValue) {
  throw new Error(
    "Missing required context. Provide microvmRegion and apiGatewayApiKeyValue, for example: " +
      "cdk deploy -c microvmRegion=ap-northeast-1 -c apiGatewayApiKeyValue=<long-random-key>"
  );
}

if (microvmDeployPhase !== "build" && microvmDeployPhase !== "runtime") {
  throw new Error("microvmDeployPhase must be either 'build' or 'runtime'.");
}

if (
  microvmDeployPhase === "runtime" &&
  microvmEgressConnectorArn &&
  String(microvmEgressConnectorArn) === internetEgressConnectorArn
) {
  throw new Error(
    "microvmEgressConnectorArn=INTERNET_EGRESS is incompatible with private Aurora access. " +
      "Use the stack-managed VPC egress connector (omit microvmEgressConnectorArn) " +
      "or provide your own VPC network-connector ARN."
  );
}

new PrivateLiteLlmMicrovmStack(app, "PrivateLiteLlmMicrovmStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  microvmRegion: String(microvmRegion),
  microvmArtifactKey: microvmArtifactKey ? String(microvmArtifactKey) : undefined,
  microvmEgressConnectorArn: microvmEgressConnectorArn ? String(microvmEgressConnectorArn) : undefined,
  runtimeUseInternetEgress: microvmDeployPhase === "build",
  publicMicrovm,
  apiGatewayApiKeyValue: String(apiGatewayApiKeyValue)
});
