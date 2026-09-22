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

function asOverridableString(contextValue: unknown, settingsValue: unknown, envValue?: string): string | undefined {
  if (contextValue !== undefined && contextValue !== null) {
    const str = String(contextValue).trim();
    if (str.length === 0 || str.toLowerCase() === "none" || str.toLowerCase() === "false") {
      return undefined;
    }
    return str;
  }
  if (settingsValue !== undefined && settingsValue !== null) {
    const str = String(settingsValue).trim();
    if (str.length > 0 && str.toLowerCase() !== "none" && str.toLowerCase() !== "false") {
      return str;
    }
    return undefined;
  }
  if (envValue) {
    const str = envValue.trim();
    if (str.length > 0 && str.toLowerCase() !== "none" && str.toLowerCase() !== "false") {
      return str;
    }
  }
  return undefined;
}

function resolveFilePath(filePathValue: string, basePath?: string): string {
  return path.isAbsolute(filePathValue) ? filePathValue : path.resolve(basePath ?? process.cwd(), filePathValue);
}

function loadJsonObjectFromFile(
  filePathValue: string,
  label: string,
  basePath?: string,
  required = true
): Record<string, unknown> | undefined {
  const resolvedPath = resolveFilePath(filePathValue, basePath);
  if (!fs.existsSync(resolvedPath)) {
    if (required) {
      throw new Error(`${label} file not found: ${resolvedPath}`);
    }
    console.warn(`[WARN] ${label} file not found: ${resolvedPath}. Provider will be disabled.`);
    return undefined;
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

function loadVertexCredentialsJson(filePathValue: string, basePath?: string, required = true): string | undefined {
  const obj = loadJsonObjectFromFile(filePathValue, "Vertex credentials", basePath, required);
  return obj ? JSON.stringify(obj) : undefined;
}

function loadAzureOpenAiConfig(
  filePathValue: string,
  basePath?: string,
  required = true
): AzureOpenAiConfig | undefined {
  const parsed = loadJsonObjectFromFile(filePathValue, "Azure OpenAI config", basePath, required);
  if (!parsed) return undefined;
  return {
    apiBase: requireStringField(parsed, "apiBase", "Azure OpenAI config file"),
    apiKey: requireStringField(parsed, "apiKey", "Azure OpenAI config file")
  };
}

function resolveVertexConfig(options: {
  project?: string;
  location?: string;
  credentialsFile?: string;
  basePath?: string;
  required?: boolean;
}): VertexConfig | undefined {
  const { project, location, credentialsFile, basePath, required } = options;
  const hasAny = Boolean(project || location || credentialsFile);
  if (!hasAny) return undefined;
  if (!credentialsFile) {
    if (required) {
      throw new Error(
        "vertexCredentialsFile is required when enabling Vertex provider. Set vertexCredentialsFile in cdk-settings.yaml, " +
          "pass -c vertexCredentialsFile=<path>, or set VERTEX_CREDENTIALS_FILE."
      );
    }
    return undefined;
  }
  const credentialsJson = loadVertexCredentialsJson(credentialsFile, basePath, required);
  if (!credentialsJson) return undefined;
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
  return {
    project,
    location,
    credentialsJson
  };
}

const settingsFileContext = app.node.tryGetContext("settingsFile");
const settingsFilePath = path.resolve(process.cwd(), String(settingsFileContext ?? "cdk-settings.yaml"));
if (!fs.existsSync(settingsFilePath)) {
  throw new Error(`Missing CDK settings file: ${settingsFilePath}`);
}
const settingsBaseDir = path.dirname(settingsFilePath);

const parsedSettings = YAML.parse(fs.readFileSync(settingsFilePath, "utf8")) as unknown;
if (!parsedSettings || typeof parsedSettings !== "object" || Array.isArray(parsedSettings)) {
  throw new Error(`Invalid settings file format at ${settingsFilePath}. Expected a YAML object.`);
}
const settings = parsedSettings as CdkSettings;

const microvmRegion = asOptionalString(app.node.tryGetContext("microvmRegion")) ?? settings.microvmRegion ?? process.env.CDK_DEFAULT_REGION;
const vertexAiProject = asOverridableString(app.node.tryGetContext("vertexAiProject"), settings.vertexAiProject);
const vertexAiLocation = asOverridableString(app.node.tryGetContext("vertexAiLocation"), settings.vertexAiLocation);
const vertexCredentialsFile = asOverridableString(
  app.node.tryGetContext("vertexCredentialsFile"),
  settings.vertexCredentialsFile,
  process.env.VERTEX_CREDENTIALS_FILE
);
const azureOpenAiConfigFile = asOverridableString(
  app.node.tryGetContext("azureOpenAiConfigFile"),
  settings.azureOpenAiConfigFile,
  process.env.AZURE_OPENAI_CONFIG_FILE
);

const isExplicitAzure = Boolean(app.node.tryGetContext("azureOpenAiConfigFile") || process.env.AZURE_OPENAI_CONFIG_FILE);
const azureOpenAiConfig = azureOpenAiConfigFile ? loadAzureOpenAiConfig(azureOpenAiConfigFile, settingsBaseDir, isExplicitAzure) : undefined;

const isExplicitVertex = Boolean(
  app.node.tryGetContext("vertexCredentialsFile") ||
  app.node.tryGetContext("vertexAiProject") ||
  process.env.VERTEX_CREDENTIALS_FILE
);
const vertexConfig = resolveVertexConfig({
  project: vertexAiProject,
  location: vertexAiLocation,
  credentialsFile: vertexCredentialsFile,
  basePath: settingsBaseDir,
  required: isExplicitVertex
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
  microvmArtifactKey: microvmArtifactKey ? String(microvmArtifactKey) : undefined,
  microvmEgressConnectorArn: microvmEgressConnectorArn ? String(microvmEgressConnectorArn) : undefined,
  microvmContainerBaseImage: microvmContainerBaseImage ? String(microvmContainerBaseImage) : undefined,
  useCodebuildEcrBaseImage,
  readinessCheckNonce,
  publicMicrovm
});
