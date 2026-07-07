import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

type LiteLlmConfig = {
  model_list?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type ProviderToggles = {
  enableAzure: boolean;
  enableVertex: boolean;
};

export function rewriteDockerfileBaseImage(dockerfile: string, baseImage?: string): string {
  if (!baseImage) return dockerfile;
  return dockerfile.replace(/^FROM\s+.+$/m, `FROM ${baseImage}`);
}

export function filterLiteLlmConfigYaml(configYaml: string, toggles: ProviderToggles): string {
  const parsedConfig = YAML.parse(configYaml) as LiteLlmConfig | null;
  if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
    throw new Error("Invalid LiteLLM config YAML. Expected top-level object.");
  }
  const modelList = parsedConfig.model_list;
  if (modelList !== undefined && !Array.isArray(modelList)) {
    throw new Error("Invalid model_list in LiteLLM config YAML. Expected array.");
  }
  const filteredModelList = (modelList ?? []).filter((entry) => {
    const litellmParams = entry?.litellm_params;
    if (!litellmParams || typeof litellmParams !== "object" || Array.isArray(litellmParams)) return true;
    const providerModel = (litellmParams as Record<string, unknown>).model;
    if (typeof providerModel !== "string") return true;
    if (providerModel.startsWith("azure/")) return toggles.enableAzure;
    if (providerModel.startsWith("vertex_ai/")) return toggles.enableVertex;
    return true;
  });

  return YAML.stringify({
    ...parsedConfig,
    model_list: filteredModelList
  });
}

export function createMicrovmImageSourceDir(
  sourceDir: string,
  options: ProviderToggles & { baseImage?: string }
): string {
  const dockerfilePath = path.join(sourceDir, "Dockerfile");
  const configPath = path.join(sourceDir, "config.yaml");
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const configYaml = fs.readFileSync(configPath, "utf8");
  const rewrittenDockerfile = rewriteDockerfileBaseImage(dockerfile, options.baseImage);
  const rewrittenConfig = filterLiteLlmConfigYaml(configYaml, options);

  const generatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "litellm-microvm-image-"));
  fs.writeFileSync(path.join(generatedDir, "Dockerfile"), rewrittenDockerfile, "utf8");
  fs.writeFileSync(path.join(generatedDir, "config.yaml"), rewrittenConfig, "utf8");
  return generatedDir;
}
