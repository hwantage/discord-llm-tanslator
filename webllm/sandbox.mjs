import { MLCEngine } from "@mlc-ai/web-llm";
import "../shared.js";
import { models } from "./catalog.mjs";
import { createWebLLMProvider } from "./provider.mjs";
import { createRpc } from "./rpc.mjs";

// This page has an opaque origin, no extension APIs, and connect-src 'none'.
// Only the parent-created MessagePort can supply model bytes or inference jobs.
window.addEventListener("message", function connect(event) {
  if (event.source !== parent || event.data !== "DT_WEBLLM_CONNECT" || event.ports.length !== 1) return;
  if (globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id) throw new Error("모델 실행 페이지가 격리되지 않았습니다.");
  window.removeEventListener("message", connect);
  let provider;
  const rpc = createRpc(event.ports[0], async (method, args) => {
    if (method === "statuses") return models.map((model) => provider.getStatus(model.id));
    if (!["startPreparation", "complete", "getStatus"].includes(method)) throw new Error("알 수 없는 모델 실행 요청입니다.");
    return provider[method](...args);
  });
  const urlOf = (request) => typeof request === "string" ? request : request.url;
  Object.defineProperty(globalThis, "caches", { value: {
    open: async (scope) => ({
      async match(request) {
        const url = urlOf(request);
        if (!await rpc.call("match", scope, url)) return undefined;
        // Avoid copying a large shard merely to check whether it exists.
        const read = () => rpc.call("read", scope, url);
        return { arrayBuffer: read, json: async () => JSON.parse(new TextDecoder().decode(await read())) };
      },
      add: (request) => rpc.call("add", scope, urlOf(request)),
      keys: async () => (await rpc.call("keys", scope)).map((url) => new Request(url))
    })
  } });
  provider = createWebLLMProvider({ MLCEngine, models,
    extensionApi: { runtime: { getPlatformInfo: async () => ({}) } },
    Shared: globalThis.DiscordTranslatorShared,
    cacheInspector: (model) => rpc.call("inspect", model.id)
  });
  rpc.call("ready").catch(() => {});
});
