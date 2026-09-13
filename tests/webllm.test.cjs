const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");
const model = require("../webllm/model.json");
const catalog = require("../webllm/catalog.json");

async function setup(overrides = {}) {
  const { createWebLLMProvider } = await import("../webllm/provider.mjs");
  const instances = [];
  const state = { cached: true, cachedModels: new Map(), supported: true, reload: async () => {},
    reply: async () => ({ model: model.id, choices: [{ finish_reason: "stop", message: { content: "안녕하세요" } }] }) };
  class Engine {
    constructor(config) {
      this.config = config; this.resets = 0; this.unloads = 0; this.interrupts = 0; this.requests = [];
      this.chat = { completions: { create: async (request) => { this.requests.push(request); return state.reply(request); } } };
      instances.push(this);
    }
    async reload(id) { assert.ok(catalog.models.some((model) => model.id === id)); this.modelId = id;
      await state.reload(this); state.cachedModels.set(id, true); }
    async resetChat() { this.resets++; }
    async unload() { this.unloads++; }
    async interruptGenerate() { this.interrupts++; }
  }
  const provider = createWebLLMProvider({
    Shared, models: catalog.models.map((entry) => ({ ...entry, wasmUrl: catalog.libraries.find((library) => library.file === entry.wasmFile).url })), MLCEngine: Engine,
    cacheInspector: async (model) => { const cached = state.cachedModels.get(model.id) ?? state.cached;
      return { cached, cacheState: cached ? "downloaded" : "missing" }; },
    cacheSnapshot: async () => null,
    extensionApi: { runtime: { getURL: (p) => `chrome-extension://fixture/${p}`, getPlatformInfo: async () => ({}) } },
    gpu: () => state.supported ? { requestAdapter: async () => ({ features: new Set(["shader-f16"]),
      limits: { maxStorageBufferBindingSize: 1_000_000_000 } }) } : undefined,
    ...overrides
  });
  return { provider, state, instances };
}

const messages = [{ role: "system", content: "Translate quoted text to Korean." }, { role: "user", content: '{"source_text":"Hello"}' }];
async function settled(provider) {
  for (let i = 0; i < 100 && provider.getStatus().phase === "loading"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.notEqual(provider.getStatus().phase, "loading");
  return provider.getStatus();
}

test("모델 ID와 격리 환경에서 사용할 실행 파일의 URL을 고정한다", async () => {
  const { provider, instances } = await setup();
  const { prebuiltAppConfig } = await import("@mlc-ai/web-llm");
  const upstream = prebuiltAppConfig.model_list.find((entry) => entry.model_id === model.id);
  assert.ok(upstream, "The selected model must exist in the installed WebLLM catalog");
  assert.equal(new URL(model.modelUrl).pathname.split("/resolve/")[0], new URL(upstream.model).pathname);
  assert.equal(new URL(model.wasmUrl).pathname.split("/").pop(), new URL(upstream.model_lib).pathname.split("/").pop());
  assert.equal(model.id, Shared.WEBLLM_MODEL_ID);
  await provider.complete(messages);
  const record = instances[0].config.appConfig.model_list.find((entry) => entry.model_id === model.id);
  assert.match(record.model, /\/resolve\/[a-f0-9]{40}\/$/);
  assert.equal(record.model_lib, model.wasmUrl);
  assert.equal(record.overrides.context_window_size, 4096);
  assert.equal(record.overrides.sliding_window_size, -1);
});

test("캐시가 없으면 Discord 요청으로 대용량 다운로드를 시작하지 않는다", async () => {
  const { provider, state, instances } = await setup();
  state.cached = false;
  await assert.rejects(provider.complete(messages), { code: "WEBLLM_NOT_READY" });
  assert.equal(instances.length, 0);
  provider.startPreparation();
  assert.equal((await settled(provider)).phase, "ready");
  await provider.complete(messages);
  assert.equal(instances.length, 1);
});

test("준비 메시지는 즉시 반환하고 중복 준비·추론은 같은 로딩을 기다린다", async () => {
  const { provider, state, instances } = await setup();
  let release;
  state.reload = () => new Promise((resolve) => { release = resolve; });
  assert.equal(provider.startPreparation().phase, "loading");
  assert.equal(provider.startPreparation().phase, "loading");
  const reply = provider.complete(messages);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 1);
  instances[0].config.initProgressCallback({ progress: 0.4 });
  assert.equal(provider.getStatus().progress, 0.4);
  release();
  assert.equal((await reply).choices[0].message.content, "안녕하세요");
});

test("WebGPU 미지원은 실행 가능한 API 대안을 안내하며 재시도할 수 있다", async () => {
  const { provider, state, instances } = await setup();
  state.supported = false;
  await assert.rejects(provider.complete(messages), { code: "WEBGPU_UNAVAILABLE" });
  assert.equal(instances.length, 0);
  state.supported = true;
  await provider.complete(messages);
  assert.equal(provider.getStatus().phase, "ready");
});

test("Qwen의 큰 텐서를 담을 수 없는 GPU는 모델 다운로드 전에 거부한다", async () => {
  const { provider, instances } = await setup({
    gpu: () => ({ requestAdapter: async () => ({ features: new Set(["shader-f16"]),
      limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024 } }) })
  });
  provider.startPreparation();
  assert.equal((await settled(provider)).error.code, "WEBGPU_UNAVAILABLE");
  assert.equal(instances.length, 0);
});

test("각 요청에서 대화 상태를 비우고 읽기 번역은 일반 텍스트, 추천은 JSON으로 요청한다", async () => {
  const { provider, instances } = await setup();
  await provider.complete(messages, { compose: true });
  await provider.complete([{ role: "user", content: "A different thread" }]);
  assert.equal(instances.length, 1);
  const engine = instances[0];
  assert.equal(engine.resets, 4);
  assert.deepEqual(engine.requests[0].messages, messages);
  const schema = JSON.parse(engine.requests[0].response_format.schema);
  assert.equal(schema.properties.suggestions.minItems, 3);
  assert.equal(Object.hasOwn(engine.requests[1], "response_format"), false);
  assert.doesNotMatch(engine.requests[1].messages[0].content, /source_text/);
});

test("잘린 응답을 성공으로 반환하지 않고 다음 요청에서 모델을 복구한다", async () => {
  const { provider, state, instances } = await setup();
  const normalReply = state.reply;
  state.reply = async () => ({ choices: [{ finish_reason: "length", message: { content: "잘린 문장" } }] });
  await assert.rejects(provider.complete(messages), { code: "WEBLLM_OUTPUT_TOO_LONG" });
  assert.equal(instances[0].unloads, 1);
  state.reply = normalReply;
  await provider.complete(messages);
  assert.equal(instances.length, 2);
});

test("문맥 초과 오류는 원문을 조용히 자르는 대신 길이 조정을 안내한다", async () => {
  const { provider, state } = await setup();
  state.reply = async () => { throw new Error("ContextWindowSizeExceededError"); };
  await assert.rejects(provider.complete(messages), { code: "WEBLLM_CONTEXT_TOO_LONG" });
});

test("초기화 실패나 제한 시간 초과가 준비 상태를 영구히 막지 않는다", async () => {
  const { provider, state, instances } = await setup({ loadTimeoutMs: 10 });
  state.reload = () => new Promise(() => {});
  provider.startPreparation();
  assert.equal((await settled(provider)).error.code, "WEBLLM_LOAD_TIMEOUT");
  assert.ok(instances[0].unloads >= 1);
  state.reload = async () => {};
  provider.startPreparation();
  assert.equal((await settled(provider)).phase, "ready");
});

test("추론 제한 시간이 지나면 생성 작업을 중단하고 오류를 반환한다", async () => {
  const { provider, state, instances } = await setup({ inferenceTimeoutMs: 10 });
  state.reply = () => new Promise(() => {});
  await assert.rejects(provider.complete(messages), { code: "TIMEOUT" });
  assert.equal(instances[0].interrupts, 1);
  assert.equal(instances[0].unloads, 1);
});

test("모델 전환 시 이전 엔진을 내리고 해당 모델의 캐시를 다시 사용한다", async () => {
  const { provider, instances } = await setup();
  const alternate = catalog.models.find((entry) => entry.id !== model.id && entry.modelType === 0).id;
  await provider.complete(messages);
  await provider.complete(messages, { modelId: alternate });
  assert.equal(instances[0].unloads, 1);
  assert.equal(instances[1].modelId, alternate);
  assert.equal(provider.getStatus(model.id).loaded, false);
  assert.equal(provider.getStatus(alternate).loaded, true);
  await provider.complete(messages);
  assert.equal(instances[1].unloads, 1);
  assert.equal(instances[2].modelId, model.id);
});

test("생성 도중 시작한 다른 모델 다운로드는 현재 요청이 끝날 때까지 기다린다", async () => {
  const { provider, state, instances } = await setup();
  const alternate = catalog.models.find((entry) => entry.id !== model.id && entry.modelType === 0).id;
  let release;
  state.reply = () => new Promise((resolve) => { release = resolve; });
  const generation = provider.complete(messages);
  await new Promise((resolve) => setImmediate(resolve));
  provider.startPreparation(alternate);
  provider.startPreparation(alternate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 1);
  assert.equal(instances[0].unloads, 0);
  release({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
  await generation;
  for (let i = 0; i < 100 && provider.getStatus(alternate).phase === "loading"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(provider.getStatus(alternate).phase, "ready");
  assert.equal(instances.length, 2);
  assert.equal(instances[0].unloads, 1);
});

test("상태·목록 조회는 GPU 초기화나 다운로드 없이 실행한다", async () => {
  const { provider, state, instances } = await setup();
  state.cached = false;
  const records = await provider.getModels();
  assert.equal(records.length, catalog.models.length);
  assert.equal((await provider.inspectModel(model.id)).cached, false);
  assert.equal(instances.length, 0);
  await assert.rejects(provider.complete(messages, { modelId: "not-a-catalog-model" }), { code: "WEBLLM_MODEL_NOT_FOUND" });
  const { prebuiltAppConfig, ModelType } = await import("@mlc-ai/web-llm");
  const embeddingId = prebuiltAppConfig.model_list.find((model) => model.model_type === ModelType.embedding).model_id;
  assert.throws(() => provider.startPreparation(embeddingId), { code: "WEBLLM_MODEL_NOT_FOUND" });
  await assert.rejects(provider.complete(messages, { modelId: embeddingId }), { code: "WEBLLM_MODEL_NOT_FOUND" });
  assert.equal(instances.length, 0);
});
