(function initializeOptions() {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const Shared = globalThis.DiscordTranslatorShared;
  const Ui = globalThis.DiscordTranslatorUi;
  const LOG_PREFIX = "[DiscordTranslator]";
  const form = document.querySelector("#settings-form");
  const endpointInput = document.querySelector("#endpoint");
  const modelInput = document.querySelector("#model");
  const apiKeyInput = document.querySelector("#api-key");
  const saveButton = document.querySelector("#save-button");
  const testButton = document.querySelector("#test-button");
  const status = document.querySelector("#status");
  let traceSequence = 0;
  const previewButton = Ui.createButtonHost();
  const previewTranslation = Ui.createTranslationHost();
  const previewExamples = [
    "도와줘서 고마워요! 내일 봐요.",
    "도와주셔서 감사해요! 내일 만나요."
  ];
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

  function createTraceId() {
    traceSequence += 1;
    return `opt-${Date.now().toString(36)}-${traceSequence.toString(36)}`;
  }

  function showStatus(message, kind = "success") {
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function setBusy(button, busy, busyLabel, idleLabel) {
    button.disabled = busy;
    button.textContent = busy ? busyLabel : idleLabel;
  }

  async function loadSettings() {
    const stored = await extensionApi.storage.local.get(["providerSettings", "uiSettings"]);
    const providerSettings = Shared.sanitizeProviderSettings(stored.providerSettings);
    const uiSettings = Shared.sanitizeUiSettings(stored.uiSettings);

    endpointInput.value = providerSettings.endpoint;
    modelInput.value = providerSettings.model;
    apiKeyInput.value = providerSettings.apiKey;
    for (const input of form.querySelectorAll('input[type="radio"]')) {
      input.checked = input.value === uiSettings[input.name];
    }
    updatePreview();
    console.info(`${LOG_PREFIX} options.ready`, {
      version: extensionApi.runtime.getManifest?.().version || "unknown",
      endpoint: providerSettings.endpoint,
      model: providerSettings.model,
      apiKeyConfigured: Boolean(providerSettings.apiKey)
    });
  }

  async function ensureEndpointPermission(endpoint) {
    const pattern = Shared.getPermissionPattern(endpoint);
    const alreadyGranted = await extensionApi.permissions.contains({ origins: [pattern] });

    if (alreadyGranted) {
      return true;
    }

    return extensionApi.permissions.request({ origins: [pattern] });
  }

  async function saveSettings({ announce = true } = {}) {
    const endpoint = Shared.normalizeApiEndpoint(endpointInput.value);
    const model = Shared.normalizeModel(modelInput.value);
    const apiKey = Shared.normalizeApiKey(apiKeyInput.value);

    if (apiKey && !Shared.isSecureApiKeyEndpoint(endpoint)) {
      throw Shared.createError(
        "INSECURE_API_KEY_ENDPOINT",
        "API 키가 설정된 원격 엔드포인트는 HTTPS를 사용해야 합니다."
      );
    }

    const granted = await ensureEndpointPermission(endpoint);
    console.info(`${LOG_PREFIX} options.permission.checked`, {
      endpoint,
      granted
    });

    if (!granted) {
      throw Shared.createError(
        "PROVIDER_PERMISSION_MISSING",
        "이 API 서버의 접근 권한이 허용되지 않았습니다. 저장할 때 권한 요청을 승인해 주세요."
      );
    }

    await extensionApi.storage.local.set({
      providerSettings: Shared.sanitizeProviderSettings({
        provider: "openai-compatible",
        endpoint,
        model,
        apiKey
      }),
      uiSettings: readUiSettings()
    });

    endpointInput.value = endpoint;
    modelInput.value = model;
    apiKeyInput.value = apiKey;

    if (announce) {
      showStatus("설정을 저장했습니다. 번역 표시 설정은 열려 있는 Discord 탭에도 적용됩니다.");
    }

    console.info(`${LOG_PREFIX} options.settings.saved`, {
      endpoint,
      model,
      apiKeyConfigured: Boolean(apiKey)
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(saveButton, true, "저장 중…", "설정 저장");

    try {
      await saveSettings();
    } catch (error) {
      console.error(`${LOG_PREFIX} options.settings.failed`, error);
      showStatus(Shared.serializeError(error).message, "error");
    } finally {
      setBusy(saveButton, false, "저장 중…", "설정 저장");
    }
  });

  testButton.addEventListener("click", async () => {
    const traceId = createTraceId();
    setBusy(testButton, true, "확인 중…", "연결 테스트");
    console.info(`${LOG_PREFIX} [${traceId}] options.test.start`);

    try {
      await saveSettings({ announce: false });
      showStatus("설정을 저장했습니다. LLM에 시험 번역을 요청하고 있습니다…", "progress");
      const response = await extensionApi.runtime.sendMessage({
        type: "TEST_PROVIDER",
        requestId: traceId
      });

      console.info(`${LOG_PREFIX} [${traceId}] options.test.response`, {
        ok: response?.ok === true,
        errorCode: response?.error?.code,
        model: response?.result?.model,
        translatedLength: response?.result?.translatedText?.length
      });

      if (!response?.ok) {
        throw Shared.createError(
          response?.error?.code || "PROVIDER_ERROR",
          response?.error?.message || "LLM API 연결을 확인하지 못했습니다."
        );
      }

      showStatus(
        `연결 성공\n모델: ${response.result.model}\n시험 번역: ${response.result.translatedText}`
      );
    } catch (error) {
      console.error(`${LOG_PREFIX} [${traceId}] options.test.failed`, error);
      const serialized = Shared.serializeError(error);
      showStatus(`연결 실패 [${serialized.code}]\n${serialized.message}`, "error");
    } finally {
      setBusy(testButton, false, "확인 중…", "연결 테스트");
    }
  });

  loadSettings().catch((error) => {
    console.error(`${LOG_PREFIX} options.load.failed`, error);
    showStatus("저장된 설정을 불러오지 못했습니다. 확장을 다시 로드해 주세요.", "error");
  });
})();
