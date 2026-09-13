import { models } from "./catalog.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { createRpc } from "./rpc.mjs";

const api = globalThis.browser ?? globalThis.chrome;
const store = createArtifactStore(models);
const iframe = document.getElementById("engine");
let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });
const channel = new MessageChannel();
const rpc = createRpc(channel.port1, (method, args) => {
  if (method === "ready") { resolveReady(); return true; }
  return store.handle(method, args);
});
iframe.addEventListener("load", () => {
  iframe.contentWindow.postMessage("DT_WEBLLM_CONNECT", "*", [channel.port2]);
}, { once: true });
iframe.src = "sandbox.html";

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "DT_WEBLLM_HOST") return false;
  if (sender.id !== api.runtime.id || !["background.js", "_generated_background_page.html"].some((file) => sender.url === api.runtime.getURL(file))) return false;
  const method = message.method;
  if (!["startPreparation", "complete", "getStatus", "statuses"].includes(method)) return false;
  (async () => {
    const args = message.args || [];
    if (method === "startPreparation") store.authorize(args[0], true);
    if (method === "complete") store.authorize(args[1].modelId, false);
    let timer;
    try {
      await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("모델 실행 환경을 시작하지 못했습니다.")), 15_000);
      })]);
    } finally { clearTimeout(timer); }
    return rpc.call(method, ...args);
  })().then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false,
    error: { name: error.name, message: error.message, code: error.code } }));
  return true;
});
