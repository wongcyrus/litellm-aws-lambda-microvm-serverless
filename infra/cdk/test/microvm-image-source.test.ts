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

