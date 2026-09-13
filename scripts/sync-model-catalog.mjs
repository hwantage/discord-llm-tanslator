// Refresh model metadata only. No model weights or WASM downloads.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prebuiltAppConfig, ModelType } from "@mlc-ai/web-llm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preferred = JSON.parse(await readFile(path.join(root, "webllm/model.json"), "utf8"));
const upstreamCommit = "5f742443179a5463e83a19f704d7c19f1f019f98";
const libraryCommit = "025bcaf3780fa8254f5e5efd3bfea0a5397248f4";
const previous = JSON.parse(await readFile(path.join(root, "webllm/catalog.json"), "utf8"));
async function request(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`${response.status}: ${url}`);
      return response;
    } catch (error) { if (attempt === 2) throw error; }
  }
}
async function parallelMap(values, fn, concurrency = 6) {
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < values.length) { const index = next++; results[index] = await fn(values[index], index); }
  }));
  return results;
}

// Compare active IDs only; upstream also contains commented-out model records.
const source = await (await request(`https://raw.githubusercontent.com/mlc-ai/web-llm/${upstreamCommit}/src/config.ts`)).text();
const activeSource = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
const ids = [...activeSource.matchAll(/model_id:\s*"([^"]+)"/g)].map((match) => match[1]).sort();
if (JSON.stringify(ids) !== JSON.stringify(prebuiltAppConfig.model_list.map((model) => model.model_id).sort())) {
  throw new Error("Installed WebLLM and the pinned upstream catalog differ. Review compatibility before updating.");
}

const supportedModels = prebuiltAppConfig.model_list.filter((model) => model.model_type !== ModelType.embedding);
const libraryUrls = [...new Set(supportedModels.map((model) =>
  model.model_lib.replace("/main/", `/${libraryCommit}/`)))];
const libraries = libraryUrls.map((url) => {
  const library = previous.libraries.find((entry) => entry.url === url);
  if (!library || !/^[a-f0-9]{64}$/.test(library.sha256) || !(library.bytes > 0)) {
    throw new Error(`Review and add a pinned SHA-256 and size for the new runtime before syncing: ${url}`);
  }
  return library;
});
const libraryByUrl = new Map(libraries.map((library) => [library.url, library]));
const metadata = new Map();
async function getMetadata(repositoryUrl, preferredUrl) {
  const key = preferredUrl || repositoryUrl;
  if (!metadata.has(key)) metadata.set(key, (async () => {
    const base = preferredUrl || `${repositoryUrl.replace(/\/$/, "")}/resolve/main/`;
    try {
      const response = await request(new URL("tensor-cache.json", base));
      const revision = response.headers.get("x-repo-commit");
      const data = await response.json();
      const weightBytes = data.records.reduce((sum, record) => sum + record.nbytes, 0);
      const largestTensor = Math.max(0, ...data.records.flatMap((record) => record.records.map((tensor) => tensor.nbytes)));
      if (!preferredUrl && !/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("Missing pinned model revision");
      return { modelUrl: preferredUrl || `${repositoryUrl.replace(/\/$/, "")}/resolve/${revision}/`,
        weightBytes, bufferBytes: largestTensor > 128 * 1024 * 1024 ? 2 ** Math.ceil(Math.log2(largestTensor)) : 0 };
    } catch (error) {
      throw new Error(`Metadata unavailable for ${repositoryUrl}; keeping the existing catalog`, { cause: error });
    }
  })());
  return metadata.get(key);
}
const models = await parallelMap(supportedModels, async (record, index) => {
  const library = libraryByUrl.get(record.model_lib.replace("/main/", `/${libraryCommit}/`));
  const isDefault = record.model_id === preferred.id;
  const info = await getMetadata(record.model, isDefault ? preferred.modelUrl : undefined);
  process.stdout.write(`Metadata ${index + 1}/${supportedModels.length}: ${record.model_id}\n`);
  return {
    id: record.model_id,
    displayName: record.model_id.replace(/-q\d[^]*$/, ""),
    repositoryUrl: record.model,
    modelUrl: info.modelUrl,
    wasmFile: library.file,
    modelType: record.model_type ?? 0,
    vramMB: record.vram_required_MB ?? null,
    weightBytes: info.weightBytes,
    bufferBytes: Math.max(info.bufferBytes, record.buffer_size_required_bytes || 0, isDefault ? preferred.bufferBytes : 0),
    requiredFeatures: record.required_features || (library.file.includes("f16") ? ["shader-f16"] : []),
    overrides: { ...record.overrides, ...(isDefault ? { context_window_size: preferred.contextWindow, sliding_window_size: preferred.slidingWindow } : {}) }
  };
});
await writeFile(path.join(root, "webllm/catalog.json"), `${JSON.stringify({
  webllmVersion: "0.2.85", upstreamCommit, libraryCommit, models, libraries
}, null, 2)}\n`);
process.stdout.write(`Catalog ready: ${models.length} models, ${libraries.length} runtimes, ${libraries.reduce((sum, library) => sum + library.bytes, 0)} runtime bytes.\n`);
