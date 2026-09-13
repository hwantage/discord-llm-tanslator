(function initializeOptions() {
  "use strict";
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const Shared = globalThis.DiscordTranslatorShared;
  const Ui = globalThis.DiscordTranslatorUi;
  const LOG_PREFIX = "[DiscordTranslator]";
  const $ = (selector) => document.querySelector(selector);
  const form = $("#settings-form");
  const providerInput = $("#provider");
  const apiFields = $("#api-settings");
  const webllmFields = $("#webllm-settings");
  const modelStatus = $("#model-status");
  const modelProgress = $("#model-progress");
  const modelSelect = $("#webllm-model");
  const modelSearch = $("#model-search");
  const modelFilter = $("#model-filter");
  const endpointInput = $("#endpoint");
  const modelInput = $("#model");
  const apiKeyInput = $("#api-key");
  const saveButton = $("#save-button");
  const downloadButton = $("#download-button");
  const webllmTestButton = $("#webllm-test-button");
  const apiTestButton = $("#api-test-button");
  const status = $("#status");
  let traceSequence = 0;
  let savedProviderSettings = Shared.sanitizeProviderSettings();
  let initialized = false;
  let catalogReady = false;
  let testRunning = false;
  let downloadStarting = false;
  let modelRecords = [];
  let observationVersion = 0;
  let observationTimer;
  const previewButton = Ui.createButtonHost();
  const previewTranslation = Ui.createTranslationHost();
  const previewExamples = ["도와줘서 고마워요! 내일 봐요.", "도와주셔서 감사해요! 내일 만나요."];
  let previewExampleIndex = 0;

  function createAppearanceChoices(container, name, choices) {
    for (const choice of choices) {
      const label = document.createElement("label");
      label.className = "appearance-choice";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = choice.id;
      const sample = document.createElement("span");
      sample.className = "choice-sample";
      sample.setAttribute("aria-hidden", "true");
      if (name === "buttonIcon") {
        sample.innerHTML = choice.markup;
      } else {
        sample.textContent = "가나다";
        sample.style.color = choice.color;
        sample.style.backgroundColor = choice.background;
      }
      const caption = document.createElement("span");
      caption.className = "choice-caption";
      caption.textContent = choice.label;
      label.append(input, sample, caption);
      input.addEventListener("change", updatePreview);
      container.append(label);
    }
  }

  function readUiSettings() {
    return Shared.sanitizeUiSettings({
      buttonIcon: form.querySelector('input[name="buttonIcon"]:checked')?.value,
      translationTheme: form.querySelector('input[name="translationTheme"]:checked')?.value
    });
  }

  function updatePreview() {
    const settings = readUiSettings();
    Ui.applyButtonSettings(previewButton.button, settings);
    Ui.applyTranslationSettings(previewTranslation.host, settings);
  }

  function setPreviewVisible(visible) {
    previewTranslation.panel.hidden = !visible;
    previewButton.button.setAttribute("aria-pressed", String(visible));
    previewButton.button.setAttribute("aria-label", visible ? "한국어 번역 숨기기" : "한국어 번역 표시");
    previewButton.button.title = visible ? "번역 숨기기" : "번역 표시";
  }

  createAppearanceChoices(document.querySelector("#icon-choices"), "buttonIcon", Shared.BUTTON_ICONS);
  createAppearanceChoices(document.querySelector("#theme-choices"), "translationTheme", Shared.TRANSLATION_THEMES);
  document.querySelector("#preview-source").append(previewButton.host);
  document.querySelector("#preview-translation").append(previewTranslation.host);
  previewTranslation.panel.dataset.state = "success";
  previewTranslation.body.textContent = previewExamples[0];
  previewTranslation.retry.hidden = false;
  setPreviewVisible(true);
  previewButton.button.addEventListener("click", () => setPreviewVisible(previewTranslation.panel.hidden));
  previewTranslation.retry.addEventListener("click", () => {
    previewExampleIndex = (previewExampleIndex + 1) % previewExamples.length;
    previewTranslation.body.textContent = previewExamples[previewExampleIndex];
  });


  const selectedProvider = () => form.querySelector('input[name="provider"]:checked')?.value || "webllm";
  const selectedModel = () => modelRecords.find((record) => record.id === modelSelect.value);
  const formatBytes = (value) => !Number.isFinite(value) ? "정보 없음"
    : value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.round(value / 1e6)} MB`;
  function createTraceId() { return `opt-${Date.now().toString(36)}-${(++traceSequence).toString(36)}`; }
  function showStatus(message, kind = "success", target = status) {
    target.textContent = message;
    target.dataset.kind = kind;
  }
  async function requestRuntime(type, requestId, modelId) {
    const response = await extensionApi.runtime.sendMessage({ type, requestId, ...(modelId ? { modelId } : {}) });
    if (!response?.ok) throw Shared.createError(response?.error?.code || "BACKGROUND_DISCONNECTED",
      response?.error?.message || "확장 백그라운드 연결이 끊겼습니다. 다시 시도해 주세요.");
    return response.result;
  }
  function updateProviderUi() {
    const webllm = selectedProvider() === "webllm";
    const model = selectedModel();
    webllmFields.hidden = !webllm;
    apiFields.hidden = webllm;
    apiFields.disabled = webllm || testRunning || !initialized;
    providerInput.disabled = !initialized || testRunning;
    saveButton.disabled = !initialized || testRunning || (webllm && !model);
    for (const input of [modelSearch, modelFilter, modelSelect]) input.disabled = !catalogReady || testRunning;
    downloadButton.disabled = !model || testRunning || downloadStarting || model.phase === "loading" || model.cached;
    downloadButton.textContent = model?.phase === "loading" ? "다운로드 중…"
      : model?.cached ? "다운로드 완료" : model?.cacheState === "partial" ? "다운로드 이어받기" : "모델 다운로드";
    webllmTestButton.disabled = !model || testRunning || model.phase === "loading" || (!model.cached && !model.loaded);
    apiTestButton.disabled = !initialized || testRunning;
    webllmTestButton.textContent = testRunning && webllm ? "연결 확인 중…" : "모델 연결 테스트";
    apiTestButton.textContent = testRunning && !webllm ? "연결 확인 중…" : "모델 연결 테스트";
  }
  function renderModelOptions(preferredId = modelSelect.value) {
    const query = modelSearch.value.trim().toLowerCase();
    const filter = modelFilter.value;
    const filtered = modelRecords.filter((model) => model.id.toLowerCase().includes(query) &&
      (filter === "all" || (filter === "downloaded" && model.cached) ||
        (filter === "chat" && model.modelType === 0) || (filter === "vision" && model.modelType === 2)));
    modelSelect.replaceChildren();
    for (const [type, label] of [[0, "문장 생성"], [2, "이미지·문장 생성"]]) {
      const entries = filtered.filter((model) => model.modelType === type).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      if (!entries.length) continue;
      const group = document.createElement("optgroup");
      group.label = `${label} (${entries.length})`;
      for (const model of entries) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = `${model.id}${model.cached ? " · 다운로드됨" : ""}`;
        group.append(option);
      }
      modelSelect.append(group);
    }
    if (filtered.some((model) => model.id === preferredId)) modelSelect.value = preferredId;
    if (!filtered.length) {
      const option = document.createElement("option");
      option.value = ""; option.textContent = "조건에 맞는 모델이 없습니다.";
      modelSelect.append(option);
    }
    $("#model-count").textContent = `전체 ${modelRecords.length}개 중 ${filtered.length}개 · 다운로드됨 ${modelRecords.filter((model) => model.cached).length}개`;
    renderSelectedModel();
  }
  function renderSelectedModel() {
    const model = selectedModel();
    $("#model-details").hidden = !model;
    if (!model) {
      modelStatus.textContent = catalogReady ? "검색어나 필터를 바꿔 모델을 찾아보세요." : "모델 목록을 불러오고 있습니다…";
      modelProgress.hidden = true;
      updateProviderUi();
      return;
    }
    $("#model-name").textContent = model.displayName;
    $("#model-size").textContent = formatBytes(model.weightBytes == null ? null : model.weightBytes + (model.wasmBytes || 0));
    $("#model-memory").textContent = formatBytes(model.vramMB === null ? null : model.vramMB * 1e6);
    $("#model-context").textContent = model.overrides.context_window_size
      ? `${model.overrides.context_window_size.toLocaleString()} 토큰` : "모델 기본값";
    $("#model-link").href = model.repositoryUrl;
    $("#model-applied").textContent = savedProviderSettings.provider === "webllm" && savedProviderSettings.webllmModelId === model.id
      ? "현재 사용 중" : "아직 적용하지 않음";
    const badgeState = model.phase === "loading" ? "loading" : model.loaded ? "ready" : model.cacheState;
    const badge = $("#model-cache-badge");
    badge.dataset.state = badgeState || "unknown";
    badge.textContent = ({ loading: "다운로드·준비 중", ready: "사용 준비 완료",
      downloaded: "다운로드됨", partial: "일부 다운로드됨", missing: "미다운로드", unknown: "확인 필요" })[badgeState] || "확인 필요";
    modelProgress.hidden = model.phase !== "loading";
    modelProgress.value = model.progress || 0;
    modelStatus.dataset.kind = model.phase === "error" ? "error" : "progress";
    modelStatus.textContent = model.message || (model.cached ? "저장된 모델입니다. 연결 테스트로 바로 확인할 수 있습니다."
      : model.dataCached && !model.wasmCached ? "모델 가중치는 저장되어 있습니다. 실행 파일만 추가로 다운로드하면 됩니다."
      : model.cacheState === "partial" ? `모델 파일 ${model.cachedShards}/${model.totalShards}개가 저장되어 있습니다. 나머지 파일을 다운로드하세요.`
      : model.cacheState === "unknown" ? "저장 상태를 확인하지 못했습니다. 모델을 다시 선택해 주세요."
      : "아직 다운로드하지 않은 모델입니다.");
    updateProviderUi();
  }
  function stopObserving() {
    observationVersion++;
    clearTimeout(observationTimer);
  }
  async function observeModelStatus() {
    stopObserving();
    const version = observationVersion;
    const id = modelSelect.value;
    if (!id || selectedProvider() !== "webllm") return;
    try {
      const result = await requestRuntime("WEBLLM_STATUS", undefined, id);
      if (version !== observationVersion || id !== modelSelect.value || selectedProvider() !== "webllm") return;
      const cacheChanged = selectedModel().cached !== result.cached;
      Object.assign(selectedModel(), result);
      if (cacheChanged) renderModelOptions(id);
      else renderSelectedModel();
      if (result.phase === "loading") observationTimer = setTimeout(observeModelStatus, 1000);
    } catch (error) {
      if (version !== observationVersion) return;
      modelStatus.textContent = error.message;
      modelStatus.dataset.kind = "error";
    }
  }
  async function loadModels() {
    const records = await requestRuntime("WEBLLM_MODELS");
    modelRecords = records;
    catalogReady = true;
    renderModelOptions(savedProviderSettings.webllmModelId);
    observeModelStatus();
  }
  for (const input of form.querySelectorAll('input[name="provider"]')) input.addEventListener("change", () => {
    stopObserving();
    updateProviderUi();
    showStatus("");
    observeModelStatus();
  });
  function changeModel() {
    stopObserving();
    showStatus("", "success", $("#webllm-test-result"));
    renderSelectedModel();
    observeModelStatus();
  }
  modelSelect.addEventListener("change", changeModel);
  for (const [input, event] of [[modelSearch, "input"], [modelFilter, "change"]]) input.addEventListener(event, () => {
    renderModelOptions(); changeModel();
  });
  window.addEventListener("pagehide", stopObserving);

  async function loadSettings() {
    const stored = await extensionApi.storage.local.get(["providerSettings", "uiSettings"]);
    savedProviderSettings = Shared.sanitizeProviderSettings(stored.providerSettings);
    endpointInput.value = savedProviderSettings.endpoint;
    modelInput.value = savedProviderSettings.model;
    apiKeyInput.value = savedProviderSettings.apiKey;
    form.querySelector(`input[name="provider"][value="${savedProviderSettings.provider}"]`).checked = true;
    const uiSettings = Shared.sanitizeUiSettings(stored.uiSettings);
    for (const input of form.querySelectorAll('input[name="buttonIcon"], input[name="translationTheme"]')) {
      input.checked = input.value === uiSettings[input.name];
    }
    initialized = true;
    updatePreview();
    updateProviderUi();
    try { await loadModels(); } catch (error) {
      modelStatus.textContent = "모델 목록을 불러오지 못했습니다. 설정 페이지를 새로고침해 주세요.";
      modelStatus.dataset.kind = "error";
      console.error(`${LOG_PREFIX} options.models.failed`, error);
    }
  }
  async function ensureEndpointPermission(endpoint) {
    const pattern = Shared.getPermissionPattern(endpoint);
    if (await extensionApi.permissions.contains({ origins: [pattern] })) return true;
    return extensionApi.permissions.request({ origins: [pattern] });
  }
  async function saveSettings({ announce = true } = {}) {
    const provider = selectedProvider();
    let profile = { ...savedProviderSettings, provider };
    if (provider === "webllm") {
      const model = selectedModel();
      if (!model) throw Shared.createError("WEBLLM_MODEL_NOT_FOUND", "번역에 사용할 모델을 선택해 주세요.");
      profile.webllmModelId = model.id;
    } else {
      const endpoint = Shared.normalizeApiEndpoint(endpointInput.value);
      const model = Shared.normalizeModel(modelInput.value);
      const apiKey = Shared.normalizeApiKey(apiKeyInput.value);
      if (apiKey && !Shared.isSecureApiKeyEndpoint(endpoint)) {
        throw Shared.createError("INSECURE_API_KEY_ENDPOINT", "API 키가 설정된 원격 엔드포인트는 HTTPS를 사용해야 합니다.");
      }
      if (!await ensureEndpointPermission(endpoint)) {
        throw Shared.createError("PROVIDER_PERMISSION_MISSING", "이 API 서버의 접근 권한이 허용되지 않았습니다. 저장할 때 권한 요청을 승인해 주세요.");
      }
      profile = { ...profile, endpoint, model, apiKey };
    }
    profile = Shared.sanitizeProviderSettings(profile);
    await extensionApi.storage.local.set({ providerSettings: profile, uiSettings: readUiSettings() });
    savedProviderSettings = profile;
    if (provider === "openai-compatible") {
      endpointInput.value = profile.endpoint; modelInput.value = profile.model; apiKeyInput.value = profile.apiKey;
    }
    renderSelectedModel();
    if (announce) showStatus("설정을 저장했습니다. 선택한 실행 방식과 모델이 번역에 적용됩니다.");
    return profile;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    try { await saveSettings(); } catch (error) { showStatus(Shared.serializeError(error).message, "error"); }
    finally { updateProviderUi(); }
  });
  downloadButton.addEventListener("click", async () => {
    const model = selectedModel();
    if (!model || downloadStarting) return;
    downloadStarting = true;
    updateProviderUi();
    try {
      const result = await requestRuntime("PREPARE_WEBLLM", createTraceId(), model.id);
      Object.assign(model, result);
      if (modelSelect.value === model.id) { renderSelectedModel(); observeModelStatus(); }
    } catch (error) {
      if (modelSelect.value === model.id) { modelStatus.textContent = error.message; modelStatus.dataset.kind = "error"; }
    } finally { downloadStarting = false; updateProviderUi(); }
  });
  async function testConnection() {
    if (testRunning || !form.reportValidity()) return;
    const webllm = selectedProvider() === "webllm";
    const target = webllm ? $("#webllm-test-result") : $("#api-test-result");
    testRunning = true;
    updateProviderUi();
    showStatus("시험 번역을 요청하고 있습니다…", "progress", target);
    try {
      await saveSettings({ announce: false });
      const result = await requestRuntime("TEST_PROVIDER", createTraceId());
      showStatus(`연결 성공\n모델: ${result.model}\n시험 번역: ${result.translatedText}`, "success", target);
    } catch (error) {
      showStatus(`연결 실패\n${Shared.serializeError(error).message}`, "error", target);
    } finally {
      testRunning = false;
      updateProviderUi();
      if (webllm) observeModelStatus();
    }
  }
  webllmTestButton.addEventListener("click", testConnection);
  apiTestButton.addEventListener("click", testConnection);
  loadSettings().catch((error) => {
    console.error(`${LOG_PREFIX} options.load.failed`, error);
    showStatus("저장된 설정을 불러오지 못했습니다. 확장을 다시 로드해 주세요.", "error");
  });
})();
