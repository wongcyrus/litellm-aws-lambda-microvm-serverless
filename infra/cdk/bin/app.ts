#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import YAML from "yaml";
import { PrivateLiteLlmMicrovmStack } from "../lib/private-litellm-microvm-stack";

const app = new cdk.App();

type CdkSettings = {
  microvmRegion?: string;
  vertexAiProject?: string;
  vertexAiLocation?: string;
  vertexCredentialsFile?: string;
  azureOpenAiConfigFile?: string;
  microvmArtifactKey?: string;
  microvmEgressConnectorArn?: string;
  microvmContainerBaseImage?: string;
  useCodebuildEcrBaseImage?: boolean;
  publicMicrovm?: boolean;
};

type AzureOpenAiConfig = {
  apiBase: string;
  apiKey: string;
  apiVersion: string;
};

type VertexConfig = {
  project: string;
  location: string;
  credentialsJson: string;
};

function parseBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  throw new Error(`${fieldName} must be a boolean (true/false).`);
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("Expected string value in settings.");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function loadJsonObjectFromFile(filePathValue: string, label: string): Record<string, unknown> {
  const resolvedPath = path.isAbsolute(filePathValue) ? filePathValue : path.resolve(process.cwd(), filePathValue);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`${label} file not found: ${resolvedPath}`);
  }
  const raw = fs.readFileSync(resolvedPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON at ${resolvedPath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} JSON must be an object: ${resolvedPath}`);
  }
  return parsed as Record<string, unknown>;
}

function requireStringField(obj: Record<string, unknown>, field: string, sourceLabel: string): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required "${field}" in ${sourceLabel}.`);
  }
  return value.trim();
}

function loadVertexCredentialsJson(filePathValue: string): string {
  return JSON.stringify(loadJsonObjectFromFile(filePathValue, "Vertex credentials"));
}

function loadAzureOpenAiConfig(filePathValue: string): AzureOpenAiConfig {
  const parsed = loadJsonObjectFromFile(filePathValue, "Azure OpenAI config");
  return {
    apiBase: requireStringField(parsed, "apiBase", "Azure OpenAI config file"),
    apiKey: requireStringField(parsed, "apiKey", "Azure OpenAI config file"),
    apiVersion: requireStringField(parsed, "apiVersion", "Azure OpenAI config file")
  };
}

function resolveVertexConfig(options: {
  project?: string;
  location?: string;
  credentialsFile?: string;
}): VertexConfig | undefined {
  const { project, location, credentialsFile } = options;
  const hasAny = Boolean(project || location || credentialsFile);
  if (!hasAny) return undefined;
  if (!project) {
    throw new Error(
      "vertexAiProject is required when enabling Vertex provider. Set it in cdk-settings.yaml or pass -c vertexAiProject=<gcp-project-id>."
    );
  }
  if (!location) {
    throw new Error(
      "vertexAiLocation is required when enabling Vertex provider. Set it in cdk-settings.yaml or pass -c vertexAiLocation=<gcp-region>."
    );
  }
  if (!credentialsFile) {
    throw new Error(
      "vertexCredentialsFile is required when enabling Vertex provider. Set vertexCredentialsFile in cdk-settings.yaml, " +
        "pass -c vertexCredentialsFile=<path>, or set VERTEX_CREDENTIALS_FILE."
    );
  }
  return {
    project,
    location,
    credentialsJson: loadVertexCredentialsJson(credentialsFile)
  };
}

const settingsFileContext = app.node.tryGetContext("settingsFile");
const settingsFilePath = path.resolve(process.cwd(), String(settingsFileContext ?? "cdk-settings.yaml"));
if (!fs.existsSync(settingsFilePath)) {
  throw new Error(`Missing CDK settings file: ${settingsFilePath}`);
}

const parsedSettings = YAML.parse(fs.readFileSync(settingsFilePath, "utf8")) as unknown;
if (!parsedSettings || typeof parsedSettings !== "object" || Array.isArray(parsedSettings)) {
  throw new Error(`Invalid settings file format at ${settingsFilePath}. Expected a YAML object.`);
}
const settings = parsedSettings as CdkSettings;

const microvmRegion = asOptionalString(app.node.tryGetContext("microvmRegion")) ?? settings.microvmRegion ?? process.env.CDK_DEFAULT_REGION;
const vertexAiProject = asOptionalString(app.node.tryGetContext("vertexAiProject")) ?? settings.vertexAiProject;
const vertexAiLocation = asOptionalString(app.node.tryGetContext("vertexAiLocation")) ?? settings.vertexAiLocation;
const vertexCredentialsFile =
  asOptionalString(app.node.tryGetContext("vertexCredentialsFile")) ??
  settings.vertexCredentialsFile ??
  asOptionalString(process.env.VERTEX_CREDENTIALS_FILE);
const azureOpenAiConfigFile =
  asOptionalString(app.node.tryGetContext("azureOpenAiConfigFile")) ??
  settings.azureOpenAiConfigFile ??
  asOptionalString(process.env.AZURE_OPENAI_CONFIG_FILE);
const azureOpenAiConfig = azureOpenAiConfigFile ? loadAzureOpenAiConfig(azureOpenAiConfigFile) : undefined;
const vertexConfig = resolveVertexConfig({
  project: vertexAiProject,
  location: vertexAiLocation,
  credentialsFile: vertexCredentialsFile
});
const microvmArtifactKey = asOptionalString(app.node.tryGetContext("microvmArtifactKey")) ?? settings.microvmArtifactKey;
const microvmEgressConnectorArn = asOptionalString(app.node.tryGetContext("microvmEgressConnectorArn")) ?? settings.microvmEgressConnectorArn;
const microvmContainerBaseImage =
  asOptionalString(app.node.tryGetContext("microvmContainerBaseImage")) ?? settings.microvmContainerBaseImage;
const useCodebuildEcrBaseImageContext = app.node.tryGetContext("useCodebuildEcrBaseImage");
const useCodebuildEcrBaseImage =
  useCodebuildEcrBaseImageContext !== undefined
    ? parseBoolean(useCodebuildEcrBaseImageContext, "useCodebuildEcrBaseImage")
    : settings.useCodebuildEcrBaseImage ?? false;
const publicMicrovmContext = app.node.tryGetContext("publicMicrovm");
const publicMicrovm =
  publicMicrovmContext !== undefined ? parseBoolean(publicMicrovmContext, "publicMicrovm") : settings.publicMicrovm ?? true;
const readinessCheckNonce = new Date().toISOString();
const internetEgressConnectorArn = `arn:aws:lambda:${microvmRegion}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

if (!microvmRegion) {
  throw new Error(
    "Missing microvmRegion. Set it in cdk-settings.yaml or pass -c microvmRegion=<aws-region>."
  );
}
if (microvmEgressConnectorArn && String(microvmEgressConnectorArn) === internetEgressConnectorArn) {
  throw new Error(
    "microvmEgressConnectorArn=INTERNET_EGRESS is incompatible with Aurora access in single-phase mode. " +
      "Use the stack-managed VPC egress connector (omit microvmEgressConnectorArn) " +
      "or provide your own VPC network-connector ARN."
  );
}

new PrivateLiteLlmMicrovmStack(app, "PrivateLiteLlmMicrovmStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: String(microvmRegion)
  },
  microvmRegion: String(microvmRegion),
  vertexAiProject: vertexConfig?.project,
  vertexAiLocation: vertexConfig?.location,
  vertexCredentialsJson: vertexConfig?.credentialsJson,
  azureApiBase: azureOpenAiConfig?.apiBase,
  azureApiKey: azureOpenAiConfig?.apiKey,
  azureApiVersion: azureOpenAiConfig?.apiVersion,
  microvmArtifactKey: microvmArtifactKey ? String(microvmArtifactKey) : undefined,
  microvmEgressConnectorArn: microvmEgressConnectorArn ? String(microvmEgressConnectorArn) : undefined,
  microvmContainerBaseImage: microvmContainerBaseImage ? String(microvmContainerBaseImage) : undefined,
  useCodebuildEcrBaseImage,
  readinessCheckNonce,
  publicMicrovm
});
