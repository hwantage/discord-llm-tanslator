const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");
const catalog = require("../webllm/catalog.json");

test("상태 조회는 실행 페이지를 만들지 않고 첫 실행 때 한 개만 생성한다", async () => {
  const { createWebLLMProxy } = await import("../webllm/proxy.mjs");
  let exists = false;
  let created = 0;
  const calls = [];
  const api = { offscreen: { createDocument: async (options) => {
    created++; assert.deepEqual(options.reasons, ["IFRAME_SCRIPTING"]);
    await new Promise((resolve) => setImmediate(resolve)); exists = true;
  } }, runtime: { getURL: (file) => `chrome-extension://fixture/${file}`,
    getContexts: async () => exists ? [{}] : [], getPlatformInfo: async () => ({}),
    sendMessage: async (message) => { calls.push(message); return { ok: true, result: { phase: "ready" } }; } } };
  const proxy = createWebLLMProxy({ models: catalog.models, extensionApi: api, Shared });
  assert.equal((await proxy.getStatus()).loaded, false);
  assert.equal(created, 0);
  assert.equal(calls.length, 0);
  await Promise.all([proxy.startPreparation(), proxy.startPreparation()]);
  assert.equal(created, 1);
  assert.ok(calls.every((message) => message.target === "DT_WEBLLM_HOST"));
  await proxy.complete([{ role: "user", content: "Hello" }], { compose: false });
  assert.equal(calls.at(-1).args[1].modelId, Shared.WEBLLM_MODEL_ID);
  // A restarted worker discovers and reuses the existing offscreen document.
  const restarted = createWebLLMProxy({ models: catalog.models, extensionApi: api, Shared });
  assert.equal((await restarted.getStatus()).phase, "ready");
  assert.equal(created, 1);
});

test("빌드는 네트워크 요청과 WASM 동봉 없이 전체 모델 목록을 포함한다", async () => {
  const { buildWebLLM } = await import("../scripts/build-webllm.mjs");
  const { mkdtemp, readdir, stat, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const path = require("node:path");
  const output = await mkdtemp(path.join(tmpdir(), "dt-light-build-"));
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Build must not download artifacts"); };
  try {
    await buildWebLLM(path.resolve(__dirname, ".."), output);
    const files = await readdir(path.join(output, "webllm"));
    assert.equal(files.some((file) => file.endsWith(".wasm")), false);
    assert.ok(files.includes("sandbox.js"));
    assert.ok(files.includes("catalog.json"));
    assert.ok((await stat(path.join(output, "webllm-provider.js"))).size < 250_000);
    assert.ok((await stat(path.join(output, "webllm/sandbox.js"))).size < 8_000_000);
  } finally { globalThis.fetch = original; await rm(output, { recursive: true, force: true }); }
});
