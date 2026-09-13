import { inspectModelCache, getCacheSnapshot } from "./cache.mjs";

// Privileged side of the sandbox boundary: exact, pinned artifact URLs only.
// The sandbox cannot choose a host, request method, headers, or request body.
export function createArtifactStore(models, { storage = globalThis.caches,
  fetcher = globalThis.fetch.bind(globalThis), crypto = globalThis.crypto } = {}) {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const authorized = new Map();
  const pending = new Map();
  const fail = (message) => { throw new Error(message); };
  function authorize(modelId, allowDownload) {
    const model = catalog.get(modelId);
    if (!model) fail("지원 목록에 없는 모델입니다.");
    authorized.set(modelId, { model, allowDownload: !!allowDownload || authorized.get(modelId)?.allowDownload });
  }
  async function locate(scope, url) {
    if (typeof url !== "string" || !["webllm/model", "webllm/config", "webllm/wasm"].includes(scope)) fail("허용되지 않은 모델 파일 요청입니다.");
    for (const entry of authorized.values()) {
      const { model } = entry;
      if (scope === "webllm/wasm" && url === model.wasmUrl) return entry;
      if (scope === "webllm/config" && url === new URL("mlc-chat-config.json", model.modelUrl).href) return entry;
      if (scope !== "webllm/model" || !url.startsWith(model.modelUrl)) continue;
      if (url === new URL("tensor-cache.json", model.modelUrl).href ||
          ["tokenizer.json", "tokenizer.model"].some((file) => url === new URL(file, model.modelUrl).href)) return entry;
      const cache = await storage.open(scope);
      const manifest = await cache.match(new URL("tensor-cache.json", model.modelUrl).href);
      const records = manifest ? (await manifest.json()).records : [];
      if (records?.some((record) => typeof record.dataPath === "string" &&
          new URL(record.dataPath, model.modelUrl).href === url)) return entry;
    }
    fail("선택한 모델에 속하지 않는 파일 요청입니다.");
  }
  async function verifyWasm(response, model) {
    const bytes = await response.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== model.wasmSha256) fail("모델 실행 파일의 검증에 실패했습니다. 다시 다운로드해 주세요.");
    return bytes;
  }
  async function readResponse(scope, url, entry) {
    const cache = await storage.open(scope);
    const response = await cache.match(url);
    if (!response || scope !== "webllm/wasm") return response;
    try {
      await verifyWasm(response.clone(), entry.model);
      return response;
    } catch {
      await cache.delete(url);
      return undefined;
    }
  }
  async function add(scope, url, entry) {
    const key = `${scope}:${url}`;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      if (await readResponse(scope, url, entry)) return;
      if (!entry.allowDownload) fail("모델 설정에서 다운로드를 먼저 실행해 주세요.");
      const response = await fetcher(url, { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(180_000) });
      if (!response.ok) fail(`모델 파일 다운로드에 실패했습니다. HTTP ${response.status}`);
      if (scope === "webllm/wasm") await verifyWasm(response.clone(), entry.model);
      await (await storage.open(scope)).put(url, response);
    })();
    pending.set(key, operation);
    try { await operation; } finally { pending.delete(key); }
  }
  async function handle(method, args) {
    if (method === "keys") {
      const [scope] = args;
      if (!["webllm/model", "webllm/config", "webllm/wasm"].includes(scope)) fail("허용되지 않은 모델 저장소입니다.");
      const keys = await (await storage.open(scope)).keys();
      const allowed = await Promise.all(keys.map(async ({ url }) => {
        try { await locate(scope, url); return url; } catch { return null; }
      }));
      return allowed.filter(Boolean);
    }
    if (method === "inspect") {
      if (!authorized.has(args[0])) fail("선택하지 않은 모델입니다.");
      return inspectModelCache(catalog.get(args[0]), await getCacheSnapshot(storage));
    }
    if (!["match", "read", "add"].includes(method)) fail("허용되지 않은 모델 저장소 요청입니다.");
    const [scope, url] = args;
    const entry = await locate(scope, url);
    if (method === "add") return add(scope, url, entry);
    const response = await readResponse(scope, url, entry);
    if (method === "match") return !!response;
    if (!response) fail("저장된 모델 파일을 찾을 수 없습니다.");
    return response.arrayBuffer();
  }
  return { authorize, handle };
}
