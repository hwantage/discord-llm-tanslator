const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../webllm/catalog.json");

const library = catalog.libraries.find((library) => library.file === catalog.models[0].wasmFile);
const model = { ...catalog.models[0], wasmUrl: library.url, wasmBytes: 50 };
const url = (file) => new URL(file, model.modelUrl).href;
function fixture() {
  const modelFiles = new Map([
    [url("tensor-cache.json"), { records: [{ dataPath: "one.bin", nbytes: 100 }, { dataPath: "two.bin", nbytes: 200 }] }],
    [url("one.bin"), "one"], [url("two.bin"), "two"], [url("tokenizer.json"), {}]
  ]);
  const configFiles = new Map([[url("mlc-chat-config.json"), { tokenizer_files: ["tokenizer.json"] }]]);
  const wasmFiles = new Map([[model.wasmUrl, "wasm"]]);
  const cache = (files) => ({
    keys: async () => [...files.keys()].map((url) => ({ url })),
    match: async (key) => files.has(key) ? { json: async () => files.get(key) } : undefined
  });
  const storage = { keys: async () => ["unrelated", "webllm/model", "webllm/config", "webllm/wasm"], open: async (name) => {
    assert.ok(["webllm/model", "webllm/config", "webllm/wasm"].includes(name));
    return cache(name === "webllm/model" ? modelFiles : name === "webllm/config" ? configFiles : wasmFiles);
  } };
  return { modelFiles, configFiles, wasmFiles, storage };
}

test("모든 샤드와 토크나이저·설정이 있어야 다운로드 완료로 표시한다", async () => {
  const { inspectModelCache, getCacheSnapshot } = await import("../webllm/cache.mjs");
  const { storage, modelFiles, configFiles, wasmFiles } = fixture();
  const inspect = async () => inspectModelCache(model, await getCacheSnapshot(storage));
  const full = await inspect();
  assert.equal(full.cached, true);
  assert.equal(full.downloadedBytes, 350);
  assert.equal(full.totalShards, 2);
  modelFiles.delete(url("two.bin"));
  const partial = await inspect();
  assert.equal(partial.cacheState, "partial");
  assert.equal(partial.cached, false);
  assert.equal(partial.downloadedBytes, 150);
  modelFiles.set(url("two.bin"), "two");
  modelFiles.delete(url("tokenizer.json"));
  assert.equal((await inspect()).cached, false);
  modelFiles.set(url("tokenizer.json"), {});
  wasmFiles.clear();
  assert.equal((await inspect()).cached, false);
  assert.equal((await inspect()).dataCached, true);
  assert.equal((await inspect()).wasmCached, false);
  configFiles.clear();
  assert.equal((await inspect()).cached, false);
});

test("빈 캐시와 다른 모델·버전의 캐시를 다운로드된 모델로 오인하지 않는다", async () => {
  const { inspectModelCache, getCacheSnapshot } = await import("../webllm/cache.mjs");
  const { storage } = fixture();
  const snapshot = await getCacheSnapshot(storage);
  assert.equal((await inspectModelCache({ ...model, modelUrl: model.modelUrl.replace(/\/resolve\/[^/]+\//, "/resolve/another-version/") }, snapshot)).cached, false);
  assert.equal((await inspectModelCache(model, await getCacheSnapshot({ keys: async () => [] }))).cacheState, "missing");
});

test("임베딩을 제외한 공식 지원 모델과 필요한 실행 파일만 포함하고 버전·해시로 고정한다", async () => {
  const { prebuiltAppConfig, ModelType } = await import("@mlc-ai/web-llm");
  const supported = prebuiltAppConfig.model_list.filter((model) => model.model_type !== ModelType.embedding);
  assert.deepEqual(catalog.models.map((model) => model.id).sort(), supported.map((model) => model.model_id).sort());
  assert.equal(catalog.models.some((model) => model.modelType === ModelType.embedding), false);
  assert.deepEqual(new Set(catalog.libraries.map((library) => library.file)), new Set(catalog.models.map((model) => model.wasmFile)));
  for (const model of catalog.models) {
    assert.match(model.modelUrl, /\/resolve\/[a-f0-9]{40}\/$/);
    assert.ok(model.weightBytes > 0);
    const library = catalog.libraries.find((library) => library.file === model.wasmFile);
    assert.ok(library);
    assert.match(library.url, /\/[a-f0-9]{40}\/web-llm-models\//);
    assert.match(library.sha256, /^[a-f0-9]{64}$/);
  }
});
