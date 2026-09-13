const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto, createHash } = require("node:crypto");

function fixture() {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const a = { id: "a", modelUrl: "https://huggingface.co/repo/a/resolve/pinned/", wasmUrl: "https://raw.githubusercontent.com/repo/pinned/a.wasm",
    wasmSha256: createHash("sha256").update(wasm).digest("hex"), wasmBytes: wasm.length };
  const b = { ...a, id: "b", modelUrl: a.modelUrl.replace("/a/", "/b/"), wasmUrl: a.wasmUrl.replace("a.wasm", "b.wasm") };
  const caches = new Map();
  const storage = { keys: async () => [...caches.keys()], open: async (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const data = caches.get(name);
    return { match: async (key) => data.get(String(key))?.clone(), put: async (key, value) => data.set(String(key), value.clone()),
      delete: async (key) => data.delete(String(key)), keys: async () => [...data.keys()].map((url) => ({ url })) };
  } };
  const requests = [];
  let corrupt = false;
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return new Response(corrupt ? "broken" : wasm);
  };
  return { a, b, wasm, storage, requests, fetcher, crypto: webcrypto, setCorrupt: (value) => { corrupt = value; } };
}

test("선택한 모델의 실행 파일만 내려받고 재사용하며 저장 전에 해시를 검증한다", async () => {
  const { createArtifactStore } = await import("../webllm/artifacts.mjs");
  const f = fixture();
  const store = createArtifactStore([f.a, f.b], f);
  await assert.rejects(store.handle("add", ["webllm/wasm", f.a.wasmUrl]));
  assert.equal(f.requests.length, 0);
  store.authorize("a", true);
  await Promise.all([store.handle("add", ["webllm/wasm", f.a.wasmUrl]), store.handle("add", ["webllm/wasm", f.a.wasmUrl])]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.method, "GET");
  assert.equal(f.requests[0].options.credentials, "omit");
  assert.deepEqual(Buffer.from(await store.handle("read", ["webllm/wasm", f.a.wasmUrl])), f.wasm);
  await store.handle("add", ["webllm/wasm", f.a.wasmUrl]);
  assert.equal(f.requests.length, 1);
  await assert.rejects(store.handle("add", ["webllm/wasm", f.b.wasmUrl]));
  store.authorize("b", true);
  f.setCorrupt(true);
  await assert.rejects(store.handle("add", ["webllm/wasm", f.b.wasmUrl]), /검증/);
  assert.equal(await store.handle("match", ["webllm/wasm", f.b.wasmUrl]), false);
});

test("격리 페이지는 임의 주소·쿼리·저장소·명령에 접근할 수 없다", async () => {
  const { createArtifactStore } = await import("../webllm/artifacts.mjs");
  const f = fixture();
  const store = createArtifactStore([f.a, f.b], f);
  store.authorize("a", true);
  for (const args of [["webllm/wasm", `${f.a.wasmUrl}?secret=x`], ["webllm/model", `${f.a.modelUrl}secret.bin`],
    ["webllm/config", "http://localhost:11434/v1"], ["user-settings", f.a.wasmUrl]]) {
    await assert.rejects(store.handle("add", args));
  }
  await assert.rejects(store.handle("fetch", [f.a.wasmUrl]));
  await assert.rejects(store.handle("inspect", ["b"]));
  assert.equal(f.requests.length, 0);
});

test("추론 요청만으로는 파일을 다운로드하지 않고 손상된 실행 파일 캐시를 재사용하지 않는다", async () => {
  const { createArtifactStore } = await import("../webllm/artifacts.mjs");
  const f = fixture();
  const store = createArtifactStore([f.a], f);
  store.authorize("a", false);
  await assert.rejects(store.handle("add", ["webllm/wasm", f.a.wasmUrl]), /다운로드/);
  assert.equal(f.requests.length, 0);
  const cache = await f.storage.open("webllm/wasm");
  await cache.put(f.a.wasmUrl, new Response("broken"));
  assert.equal(await store.handle("match", ["webllm/wasm", f.a.wasmUrl]), false);
  assert.equal(await cache.match(f.a.wasmUrl), undefined);
});
