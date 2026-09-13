import { inspectModelCache, getCacheSnapshot } from "./cache.mjs";

export function createWebLLMProxy({ models, extensionApi: api, Shared }) {
  const hostPath = "webllm/host.html";
  const hostUrl = api.runtime.getURL(hostPath);
  const catalog = new Map(models.map((model) => [model.id, model]));
  let creating;
  let hostFrame;
  function find(id = Shared.WEBLLM_MODEL_ID) {
    const model = catalog.get(id);
    if (!model) throw Shared.createError("WEBLLM_MODEL_NOT_FOUND", "선택한 모델이 지원 목록에 없습니다. 모델을 다시 선택해 주세요.");
    return model;
  }
  async function hasHost() {
    if (api.offscreen) {
      return (await api.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [hostUrl] })).length > 0;
    }
    return !!hostFrame?.isConnected;
  }
  async function ensureHost() {
    if (creating) { await creating; return; }
    if (await hasHost()) return;
    if (!creating) creating = (async () => {
      if (api.offscreen) {
        await api.offscreen.createDocument({ url: hostPath, reasons: ["IFRAME_SCRIPTING"],
          justification: "선택한 WebLLM 모델을 확장 권한과 분리된 iframe에서 로컬 GPU로 실행합니다." });
      } else if (globalThis.document) {
        hostFrame = document.createElement("iframe");
        hostFrame.hidden = true;
        hostFrame.src = hostUrl;
        await new Promise((resolve, reject) => {
          hostFrame.onload = resolve;
          hostFrame.onerror = reject;
          document.body.append(hostFrame);
        });
      } else throw Shared.createError("WEBGPU_UNAVAILABLE", "이 브라우저에서 모델 실행 환경을 사용할 수 없습니다. Ollama / API 연결을 선택해 주세요.");
    })().finally(() => { creating = null; });
    await creating;
  }
  async function call(method, args = [], create = false) {
    if (creating) await creating;
    if (create) await ensureHost();
    else if (!await hasHost()) return undefined;
    const timer = setInterval(() => api.runtime.getPlatformInfo?.().catch(() => {}), 20_000);
    try {
      const response = await api.runtime.sendMessage({ target: "DT_WEBLLM_HOST", method, args });
      if (!response?.ok) throw Shared.createError(response?.error?.code || "WEBLLM_ERROR",
        response?.error?.message || "모델 실행 환경의 연결이 끊겼습니다. 다시 시도해 주세요.");
      return response.result;
    } finally { clearInterval(timer); }
  }
  async function getStatus(modelId = Shared.WEBLLM_MODEL_ID) {
    find(modelId);
    return await call("getStatus", [modelId]) || { phase: "idle", progress: 0, message: "", model: modelId, loaded: false };
  }
  return {
    getStatus,
    async inspectModel(modelId = Shared.WEBLLM_MODEL_ID) {
      return { ...await inspectModelCache(find(modelId)), ...await getStatus(modelId) };
    },
    async getModels() {
      const snapshot = await getCacheSnapshot();
      const statuses = new Map((await call("statuses") || []).map((state) => [state.model, state]));
      return Promise.all(models.map(async (model) => ({ ...model, ...await inspectModelCache(model, snapshot),
        phase: "idle", loaded: false, ...statuses.get(model.id) })));
    },
    startPreparation(modelId = Shared.WEBLLM_MODEL_ID) {
      find(modelId);
      return call("startPreparation", [modelId], true);
    },
    complete(messages, options = {}) {
      const modelId = find(options.modelId).id;
      return call("complete", [messages, { ...options, modelId }], true);
    }
  };
}
