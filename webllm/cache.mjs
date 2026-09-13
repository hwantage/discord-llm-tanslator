// Inspect only this extension's WebLLM caches. Status checks never fetch a URL.
export async function getCacheSnapshot(storage = globalThis.caches) {
  if (!storage) return null;
  const names = await storage.keys();
  const modelCache = names.includes("webllm/model") ? await storage.open("webllm/model") : null;
  const configCache = names.includes("webllm/config") ? await storage.open("webllm/config") : null;
  const wasmCache = names.includes("webllm/wasm") ? await storage.open("webllm/wasm") : null;
  const [modelKeys, configKeys, wasmKeys] = await Promise.all([
    modelCache ? modelCache.keys() : [], configCache ? configCache.keys() : [], wasmCache ? wasmCache.keys() : []
  ]);
  return { modelCache, configCache,
    modelKeys: new Set(modelKeys.map((request) => request.url)),
    configKeys: new Set(configKeys.map((request) => request.url)),
    wasmKeys: new Set(wasmKeys.map((request) => request.url)) };
}

export async function inspectModelCache(model, snapshot) {
  snapshot = snapshot === undefined ? await getCacheSnapshot() : snapshot;
  const result = { cacheState: "missing", cached: false, downloadedBytes: 0,
    totalBytes: model.weightBytes + (model.wasmBytes || 0), cachedShards: 0, totalShards: 0,
    dataCached: false, wasmCached: false };
  if (!snapshot) return { ...result, cacheState: "unknown" };
  const { modelCache, configCache, modelKeys, configKeys, wasmKeys } = snapshot;
  result.wasmCached = !!wasmKeys?.has(model.wasmUrl);
  if (result.wasmCached) { result.cacheState = "partial"; result.downloadedBytes = model.wasmBytes || 0; }
  const tensorUrl = new URL("tensor-cache.json", model.modelUrl).href;
  const configUrl = new URL("mlc-chat-config.json", model.modelUrl).href;
  if ([...modelKeys, ...configKeys].some((url) => url.startsWith(model.modelUrl))) result.cacheState = "partial";
  if (!modelKeys.has(tensorUrl)) return result;
  try {
    const manifest = await (await modelCache.match(tensorUrl)).json();
    const records = manifest.records;
    if (!Array.isArray(records) || !records.length) return result;
    result.totalShards = records.length;
    result.totalBytes = records.reduce((sum, record) => sum + (Number(record.nbytes) || 0), model.wasmBytes || 0);
    for (const record of records) {
      if (modelKeys.has(new URL(record.dataPath, model.modelUrl).href)) {
        result.cachedShards++;
        result.downloadedBytes += Number(record.nbytes) || 0;
      }
    }
    if (result.cachedShards !== result.totalShards || !configKeys.has(configUrl)) return result;
    const config = await (await configCache.match(configUrl)).json();
    const tokenizer = ["tokenizer.json", "tokenizer.model"].find((file) => config.tokenizer_files?.includes(file));
    if (!tokenizer || !modelKeys.has(new URL(tokenizer, model.modelUrl).href)) return result;
    return { ...result, dataCached: true, cacheState: result.wasmCached ? "downloaded" : "partial", cached: result.wasmCached };
  } catch {
    return { ...result, cacheState: "partial" };
  }
}
