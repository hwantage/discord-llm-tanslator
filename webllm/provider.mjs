import { getCacheSnapshot, inspectModelCache } from "./cache.mjs";

export function createWebLLMProvider({ MLCEngine, models, extensionApi, Shared,
  gpu = () => globalThis.navigator?.gpu, loadTimeoutMs = 600_000,
  inferenceTimeoutMs = 180_000, cacheInspector = inspectModelCache, cacheSnapshot = getCacheSnapshot }) {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const appConfig = { cacheBackend: "cache", model_list: models.map((model) => ({
    model: model.modelUrl, model_id: model.id,
    model_lib: model.wasmUrl,
    model_type: model.modelType, required_features: model.requiredFeatures,
    buffer_size_required_bytes: model.bufferBytes || undefined, overrides: model.overrides
  })) };
  const states = new Map();
  const preparations = new Map();
  let engine = null;
  let loadedModelId = null;
  let queue = Promise.resolve();

  function findModel(id = Shared.WEBLLM_MODEL_ID) {
    const model = catalog.get(id);
    if (!model) throw Shared.createError("WEBLLM_MODEL_NOT_FOUND", "선택한 모델이 지원 목록에 없습니다. 설정에서 모델을 다시 선택해 주세요.");
    return model;
  }
  function getStatus(modelId = Shared.WEBLLM_MODEL_ID) {
    findModel(modelId);
    return { phase: "idle", progress: 0, message: "", ...states.get(modelId),
      model: modelId, loaded: loadedModelId === modelId && engine !== null };
  }
  async function inspectModel(modelId = Shared.WEBLLM_MODEL_ID) {
    const model = findModel(modelId);
    const cache = await cacheInspector(model);
    return { ...cache, ...getStatus(modelId) };
  }
  async function getModels() {
    const snapshot = await cacheSnapshot();
    return Promise.all(models.map(async (model) => ({
      ...model, ...await cacheInspector(model, snapshot), ...getStatus(model.id)
    })));
  }
  function setState(modelId, state) { states.set(modelId, state); }
  function convertError(error, loadingModel = false) {
    if (error?.name === "DiscordTranslatorError") return error;
    const detail = `${error?.name || ""} ${error?.message || ""}`;
    if (/ContextWindow|context window|prompt.*too long/i.test(detail)) {
      return Shared.createError("WEBLLM_CONTEXT_TOO_LONG", "내용이 선택한 모델의 처리 범위를 넘습니다. 내용을 줄여 다시 시도해 주세요.");
    }
    if (/GPU|device.*lost|out of memory|buffer.*size|shader-f16/i.test(detail)) {
      return Shared.createError("WEBGPU_UNAVAILABLE", "이 모델에 필요한 GPU 메모리 또는 기능을 사용할 수 없습니다. 더 작은 모델이나 다른 실행 방식을 선택해 주세요.");
    }
    return Shared.createError(loadingModel ? "WEBLLM_LOAD_FAILED" : "WEBLLM_ERROR",
      loadingModel ? "모델을 준비하지 못했습니다. 연결과 저장 공간을 확인하고 다시 다운로드해 주세요." : "모델 실행에 실패했습니다. 다시 시도해 주세요.");
  }
  async function keepAlive(task) {
    const timer = setInterval(() => { extensionApi.runtime.getPlatformInfo?.().catch(() => {}); }, 20_000);
    try { return await task(); } finally { clearInterval(timer); }
  }
  // Downloads, model switches and generation share one queue so a switch cannot
  // unload the GPU while another Discord request is still using it.
  function exclusive(task) {
    const operation = keepAlive(() => queue.then(task));
    queue = operation.catch(() => {});
    return operation;
  }
  async function deadline(task, milliseconds, onTimeout, code, message) {
    let timer;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => {
          Promise.resolve().then(onTimeout).catch(() => {});
          reject(Shared.createError(code, message));
        }, milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function checkGPU(model) {
    const adapter = await gpu()?.requestAdapter();
    if (!adapter || model.requiredFeatures.some((feature) => !adapter.features.has(feature)) ||
        (model.bufferBytes && adapter.limits.maxStorageBufferBindingSize < model.bufferBytes)) {
      throw Shared.createError("WEBGPU_UNAVAILABLE", "이 모델에 필요한 WebGPU 기능이나 메모리를 사용할 수 없습니다. 다른 모델을 선택해 주세요.");
    }
  }
  async function unload() {
    const previous = loadedModelId;
    const current = engine;
    engine = null;
    loadedModelId = null;
    if (previous) setState(previous, { phase: "idle", progress: 0, message: "" });
    await current?.unload().catch(() => {});
  }
  async function prepare(model, allowDownload) {
    if (engine && loadedModelId === model.id) return engine;
    let candidate;
    try {
      await checkGPU(model);
      const cached = await cacheInspector(model);
      if (!allowDownload && !cached.cached) {
        throw Shared.createError("WEBLLM_NOT_READY", "선택한 모델이 다운로드되지 않았습니다. 모델 설정에서 다운로드해 주세요.");
      }
      await unload();
      setState(model.id, { phase: "loading", progress: 0,
        message: cached.cached ? "저장된 모델을 불러오고 있습니다…" : "모델을 다운로드하고 있습니다…" });
      candidate = new MLCEngine({ appConfig, logLevel: "error", initProgressCallback: (report) => {
        const state = getStatus(model.id);
        if (state.phase !== "loading") return;
        const progress = Math.max(state.progress, Math.min(0.99, Number(report.progress) || 0));
        setState(model.id, { phase: "loading", progress, message: `모델 다운로드 및 준비 중… ${Math.floor(progress * 100)}%` });
      } });
      await deadline(candidate.reload(model.id), loadTimeoutMs, () => candidate.unload(),
        "WEBLLM_LOAD_TIMEOUT", "모델 준비 시간이 초과되었습니다. 다운로드 버튼으로 다시 시도해 주세요.");
      engine = candidate;
      loadedModelId = model.id;
      setState(model.id, { phase: "ready", progress: 1, message: "모델을 사용할 준비가 되었습니다." });
      return engine;
    } catch (error) {
      console.error("[DiscordTranslator] WebLLM load failed", { model: model.id, name: error?.name, message: error?.message });
      const failure = convertError(error, true);
      setState(model.id, { phase: "error", progress: 0, message: failure.message, error: Shared.serializeError(failure) });
      await candidate?.unload().catch(() => {});
      throw failure;
    }
  }
  function startPreparation(modelId = Shared.WEBLLM_MODEL_ID) {
    const model = findModel(modelId);
    if (preparations.has(modelId) || (engine && loadedModelId === modelId)) return getStatus(modelId);
    setState(modelId, { phase: "loading", progress: 0, message: "모델 다운로드를 준비하고 있습니다…" });
    const operation = exclusive(() => prepare(model, true));
    preparations.set(modelId, operation);
    operation.catch(() => {}).finally(() => preparations.delete(modelId));
    return getStatus(modelId);
  }
  async function complete(messages, { compose = false, modelId = Shared.WEBLLM_MODEL_ID } = {}) {
    const model = findModel(modelId);
    return exclusive(async () => {
      const current = await prepare(model, false);
      let timerExpired = false;
      try {
        await current.resetChat();
        const response = await deadline(current.chat.completions.create({
          messages, stream: false, temperature: compose ? 0.4 : 0, max_tokens: 1536,
          ...(compose ? { response_format: { type: "json_object", schema: JSON.stringify({
            type: "object", properties: { suggestions: {
              type: "array", minItems: 3, maxItems: 3,
              items: { type: "object", properties: {
                tone: { type: "string", enum: ["natural", "friendly", "polite"] },
                en: { type: "string" }, ko: { type: "string" }
              }, required: ["tone", "en", "ko"], additionalProperties: false }
            } }, required: ["suggestions"], additionalProperties: false
          }) } } : {})
        }), inferenceTimeoutMs, () => { timerExpired = true; return current.interruptGenerate(); },
        "TIMEOUT", "모델 응답 시간이 초과되었습니다. 다시 시도해 주세요.");
        if (response.choices?.[0]?.finish_reason === "length") {
          throw Shared.createError("WEBLLM_OUTPUT_TOO_LONG", "모델의 응답 길이 제한에 도달했습니다. 내용을 줄여 다시 시도해 주세요.");
        }
        return response;
      } catch (error) {
        const failure = convertError(error);
        await unload();
        setState(model.id, { phase: "error", progress: 0, message: failure.message, error: Shared.serializeError(failure) });
        throw failure;
      } finally {
        if (!timerExpired && engine === current) await current.resetChat().catch(() => {});
      }
    });
  }
  return { startPreparation, getStatus, inspectModel, getModels, complete };
}
