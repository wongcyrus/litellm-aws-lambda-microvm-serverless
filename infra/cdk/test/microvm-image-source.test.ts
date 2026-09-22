import test from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { filterLiteLlmConfigYaml, rewriteDockerfileBaseImage } from "../lib/microvm-image-source";

const sampleConfig = `
model_list:
  - model_name: aws-a
    litellm_params:
      model: bedrock/a
  - model_name: az-a
    litellm_params:
      model: azure/gpt-5.4-mini
  - model_name: gcp-a
    litellm_params:
      model: vertex_ai/gemini-2.5-pro
`;

function modelIdsFromConfig(configYaml: string): string[] {
  const parsed = YAML.parse(configYaml) as { model_list?: Array<{ model_name?: string }> };
  return (parsed.model_list ?? []).map((m) => String(m.model_name));
}

test("filters azure and vertex models when providers are disabled", () => {
  const out = filterLiteLlmConfigYaml(sampleConfig, { enableAzure: false, enableVertex: false });
  assert.deepEqual(modelIdsFromConfig(out), ["aws-a"]);
});

test("keeps enabled provider models", () => {
  const out = filterLiteLlmConfigYaml(sampleConfig, { enableAzure: true, enableVertex: false });
  assert.deepEqual(modelIdsFromConfig(out), ["aws-a", "az-a"]);
});

test("throws on invalid model_list type", () => {
  assert.throws(
    () => filterLiteLlmConfigYaml("model_list: not-an-array", { enableAzure: true, enableVertex: true }),
    /Invalid model_list/
  );
});

test("rewrites docker base image when provided", () => {
  const dockerfile = "FROM old/image:tag\nWORKDIR /app\n";
  const out = rewriteDockerfileBaseImage(dockerfile, "new/image:latest");
  assert.match(out, /^FROM new\/image:latest/m);
});

test("parses repo config.yaml and includes kimi-k3", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const configPath = path.resolve(__dirname, "../../microvm-image/config.yaml");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw) as {
    model_list: Array<{ model_name: string; litellm_params: { model: string } }>;
  };
  assert.ok(Array.isArray(parsed.model_list));
  const kimiK3 = parsed.model_list.find((m) => m.model_name === "kimi-k3");
  assert.ok(kimiK3, "kimi-k3 model must exist");
  assert.equal(kimiK3.litellm_params.model, "bedrock/global.moonshotai.kimi-k3");

  const filtered = filterLiteLlmConfigYaml(raw, { enableAzure: false, enableVertex: false });
  const filteredModels = modelIdsFromConfig(filtered);
  assert.ok(filteredModels.includes("kimi-k3"));
  assert.ok(!filteredModels.includes("kimi-3"));
});

