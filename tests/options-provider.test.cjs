const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");
const catalog = require("../webllm/catalog.json");
const Shared = require("../shared.js");
const root = path.resolve(__dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const A = Shared.WEBLLM_MODEL_ID;
const B = "SmolLM2-360M-Instruct-q4f16_1-MLC";
const V = catalog.models.find((model) => model.modelType === 2).id;
const fixtures = catalog.models.filter((model) => [A, B, V].includes(model.id));

async function setup(providerSettings, options = {}) {
  const state = { stored: { providerSettings }, messages: [], permissionCalls: [],
    cached: new Set(options.cached || []), phases: new Map(), statusHandler: null };
  const dom = new JSDOM(read("options/options.html"), { runScripts: "outside-only",
    url: "https://extension.example/options/options.html", virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const modelStatus = (id) => ({ model: id, cached: state.cached.has(id),
    cacheState: state.cached.has(id) ? "downloaded" : "missing",
    phase: "idle", progress: 0, message: "", ...state.phases.get(id) });
  window.chrome = {
    storage: { local: {
      get: async () => state.stored,
      set: async (value) => { state.stored = JSON.parse(JSON.stringify(value)); }
    } },
    permissions: {
      contains: async (value) => { state.permissionCalls.push(value); return false; },
      request: async (value) => { state.permissionCalls.push(value); return true; }
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async (message) => {
        state.messages.push(message);
        if (message.type === "WEBLLM_MODELS") return { ok: true, result: fixtures.map((model) =>
          JSON.parse(JSON.stringify({ ...model, ...modelStatus(model.id) }))) };
        if (message.type === "WEBLLM_STATUS") {
          if (state.statusHandler) return state.statusHandler(message.modelId, modelStatus);
          return { ok: true, result: modelStatus(message.modelId) };
        }
        if (message.type === "PREPARE_WEBLLM") {
          if (options.prepareError) state.phases.set(message.modelId, { phase: "error", error: options.prepareError, message: options.prepareError.message });
          else { state.cached.add(message.modelId); state.phases.set(message.modelId, { phase: "ready", loaded: true, progress: 1 }); }
          return { ok: true, result: modelStatus(message.modelId) };
        }
        if (message.type === "TEST_PROVIDER") return { ok: true, result: {
          model: state.stored.providerSettings.webllmModelId || "fixture", translatedText: "Hello, nice to meet you."
        } };
        throw new Error(message.type);
      }
    }
  };
  window.eval(read("shared.js")); window.eval(read("inline-ui.js")); window.eval(read("options/options.js"));
  await tick();
  const $ = (selector) => window.document.querySelector(selector);
  const select = (value) => {
    const input = $(`input[name="provider"][value="${value}"]`);
    input.checked = true; input.dispatchEvent(new window.Event("change"));
  };
  const selectModel = (value) => { $("#webllm-model").value = value; $("#webllm-model").dispatchEvent(new window.Event("change")); };
  const save = async () => { $("#settings-form").dispatchEvent(new window.Event("submit", { cancelable: true })); await tick(); };
  return { dom, state, $, select, selectModel, save };
}

test("새 설치는 선택한 모델만 다운로드하고 모델 옆에서 테스트한다", async (t) => {
  const { dom, state, $ } = await setup(); t.after(() => dom.window.close());
  assert.equal($("#provider-webllm").checked, true);
  assert.equal($("#api-settings").disabled, true);
  assert.equal($("#api-settings").hidden, true);
  assert.equal($("#webllm-settings").hidden, false);
  assert.equal($("#webllm-model").value, A);
  assert.equal($("#webllm-test-button").disabled, true);
  assert.equal(state.messages.some((m) => m.type === "PREPARE_WEBLLM"), false);
  $("#download-button").click(); await tick();
  assert.deepEqual(state.messages.filter((m) => m.type === "PREPARE_WEBLLM").map((m) => m.modelId), [A]);
  assert.equal(state.stored.providerSettings, undefined, "다운로드만으로 저장한 실행 방식을 바꾸지 않는다");
  assert.equal($("#webllm-test-button").disabled, false);
  $("#webllm-test-button").click(); await tick();
  assert.equal(state.stored.providerSettings.webllmModelId, A);
  assert.deepEqual(state.permissionCalls, []);
  assert.match($("#webllm-test-result").textContent, /연결 성공/);
  assert.match($("#webllm-test-result").textContent, /Hello, nice to meet you/);
  assert.equal($("#webllm-test-button").closest("#webllm-settings")?.id, "webllm-settings");
});

test("저장된 모델은 재다운로드 없이 상태를 보여 주고 다른 모델을 적용할 수 있다", async (t) => {
  const { dom, state, $, selectModel } = await setup({ provider: "webllm", webllmModelId: B }, { cached: [A, B] });
  t.after(() => dom.window.close());
  assert.equal($("#webllm-model").value, B);
  assert.equal($("#model-cache-badge").textContent, "다운로드됨");
  assert.equal($("#download-button").disabled, true);
  selectModel(A); await tick();
  $("#webllm-test-button").click(); await tick();
  assert.equal(state.stored.providerSettings.webllmModelId, A);
  assert.equal(state.messages.some((m) => m.type === "PREPARE_WEBLLM"), false);
});

test("API와 WebLLM의 모델·서버·키를 각각 보존한다", async (t) => {
  const { dom, state, $, select, selectModel, save } = await setup(); t.after(() => dom.window.close());
  selectModel(B); await save();
  select("openai-compatible");
  $("#endpoint").value = "https://api.example.com/v1";
  $("#model").value = "existing/model"; $("#api-key").value = "saved-key";
  await save();
  const profile = state.stored.providerSettings;
  assert.equal(profile.webllmModelId, B);
  assert.equal(state.permissionCalls.length, 2);
  select("webllm"); await save();
  assert.deepEqual(state.stored.providerSettings, { ...profile, provider: "webllm" });
  assert.equal(state.permissionCalls.length, 2);
  select("openai-compatible");
  assert.equal($("#api-settings").disabled, false);
  assert.equal($("#endpoint").value, profile.endpoint);
  assert.equal($("#model").value, profile.model);
  assert.equal($("#api-key").value, profile.apiKey);
  assert.equal($("#api-test-button").closest("#api-settings")?.id, "api-settings");
});

test("기존 Ollama 설정을 복원하고 API 테스트에서 모델을 다운로드하지 않는다", async (t) => {
  const { dom, state, $ } = await setup({ provider: "ollama", endpoint: "http://localhost:11434", model: "saved-model" });
  t.after(() => dom.window.close());
  assert.equal($("#provider-api").checked, true);
  assert.equal($("#endpoint").value, "http://localhost:11434/v1");
  $("#api-test-button").click(); await tick();
  assert.equal(state.messages.filter((m) => m.type === "TEST_PROVIDER").length, 1);
  assert.equal(state.messages.some((m) => m.type === "PREPARE_WEBLLM"), false);
  assert.equal(state.stored.providerSettings.model, "saved-model");
});

test("준비 실패 후에도 모델이나 실행 방식을 바꿀 수 있다", async (t) => {
  const { dom, state, $, select } = await setup(undefined, { prepareError: { code: "WEBGPU_UNAVAILABLE", message: "GPU를 사용할 수 없습니다." } });
  t.after(() => dom.window.close());
  $("#download-button").click(); await tick();
  assert.match($("#model-status").textContent, /GPU를 사용할 수 없습니다/);
  assert.equal(state.messages.some((m) => m.type === "TEST_PROVIDER"), false);
  assert.equal($("#provider").disabled, false);
  assert.equal($("#webllm-model").disabled, false);
  select("openai-compatible");
  assert.equal($("#api-settings").disabled, false);
});

test("검색과 다운로드·이미지 필터로 모델을 좁히고 임베딩 필터는 표시하지 않는다", async (t) => {
  const { dom, state, $, selectModel } = await setup(undefined, { cached: [B] });
  t.after(() => dom.window.close());
  $("#model-filter").value = "downloaded"; $("#model-filter").dispatchEvent(new dom.window.Event("change")); await tick();
  assert.equal($("#webllm-model").value, B);
  assert.equal($("#webllm-model").options.length, 1);
  $("#model-filter").value = "all"; $("#model-filter").dispatchEvent(new dom.window.Event("change")); await tick();
  $("#model-search").value = "not-present"; $("#model-search").dispatchEvent(new dom.window.Event("input")); await tick();
  assert.equal($("#download-button").disabled, true);
  $("#model-search").value = ""; $("#model-search").dispatchEvent(new dom.window.Event("input")); await tick();
  assert.equal($('#model-filter option[value="embedding"]'), null);
  $("#model-filter").value = "vision"; $("#model-filter").dispatchEvent(new dom.window.Event("change")); await tick();
  assert.equal($("#webllm-model").value, V);
  assert.equal($("#webllm-model").options.length, 1);
  $("#download-button").click(); await tick();
  assert.deepEqual(state.messages.filter((m) => m.type === "PREPARE_WEBLLM").map((m) => m.modelId), [V]);
});

test("늦게 도착한 이전 모델의 상태가 새 선택을 덮어쓰지 않는다", async (t) => {
  const { dom, state, $, selectModel } = await setup(); t.after(() => dom.window.close());
  let release;
  state.statusHandler = (id, getStatus) => id === A
    ? new Promise((resolve) => { release = resolve; })
    : { ok: true, result: getStatus(id) };
  selectModel(A); await tick();
  selectModel(B); await tick();
  release({ ok: true, result: { model: A, cached: true, cacheState: "downloaded", phase: "ready", message: "이전 모델" } });
  await tick();
  assert.equal($("#webllm-model").value, B);
  assert.equal($("#model-cache-badge").textContent, "미다운로드");
  assert.doesNotMatch($("#model-status").textContent, /이전 모델/);
});
