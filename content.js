(function initializeDiscordTranslator() {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const Shared = globalThis.DiscordTranslatorShared;
  const Ui = globalThis.DiscordTranslatorUi;
  const MESSAGE_SELECTOR =
    'li[id^="chat-messages-"], [data-list-item-id^="chat-messages"]';
  const CONTENT_SELECTORS = [
    '[id^="message-content-"]',
    '[class*="messageContent_"]',
    '[class*="markup_"]'
  ];
  const UI_ATTRIBUTE = "data-discord-translator-ui";
  const LOG_PREFIX = "[DiscordTranslator]";
  const CACHE_LIMIT = 250;
  const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI", "BLOCKQUOTE"]);
  const messageStates = new WeakMap();
  const activeStatesByCacheKey = new Map();
  const translationCache = new Map();
  const latestRequests = new Map();
  const pendingRoots = new Set();
  let uiSettings = Shared.sanitizeUiSettings();
  let scanFrame = 0;
  let traceSequence = 0;
  let extensionInvalidated = false;

  function createTraceId() {
    traceSequence += 1;
    return `dt-${Date.now().toString(36)}-${traceSequence.toString(36)}`;
  }

  function createCacheKey(messageId, sourceHash) {
    return `${messageId}:${sourceHash}:${uiSettings.targetLanguage}`;
  }

  function registerActiveState(state) {
    activeStatesByCacheKey.set(state.cacheKey, state);

    if (activeStatesByCacheKey.size > CACHE_LIMIT) {
      activeStatesByCacheKey.delete(activeStatesByCacheKey.keys().next().value);
    }
  }

  function unregisterActiveState(state) {
    if (state?.cacheKey && activeStatesByCacheKey.get(state.cacheKey) === state) {
      activeStatesByCacheKey.delete(state.cacheKey);
    }
  }

  function getActiveState(cacheKey, sourceHash) {
    const state = activeStatesByCacheKey.get(cacheKey);

    if (
      !state ||
      state.sourceHash !== sourceHash ||
      !state.host.isConnected ||
      !state.translationHost.isConnected
    ) {
      return null;
    }

    return state;
  }

  function logInfo(traceId, event, details = {}) {
    console.info(`${LOG_PREFIX} [${traceId}] ${event}`, details);
  }

  function logError(traceId, event, error, details = {}) {
    console.error(
      `${LOG_PREFIX} [${traceId}] ${event}`,
      {
        ...details,
        errorName: error?.name,
        errorMessage: error?.message,
        errorCode: error?.code
      },
      error
    );
  }

  function isRuntimeAvailable() {
    try {
      return !extensionInvalidated && Boolean(extensionApi.runtime.id);
    } catch {
      return false;
    }
  }

  function handleRuntimeInterruption(state, error, traceId) {
    const message = error?.message || "";
    const needsReload = !isRuntimeAvailable() || /extension context invalidated/i.test(message);
    const channelClosed = /message (?:channel|port) closed|receiving end does not exist|could not establish connection/i.test(message);

    if (!needsReload && !channelClosed) {
      return false;
    }

    if (needsReload) {
      extensionInvalidated = true;
      observer.disconnect();
      if (scanFrame) {
        cancelAnimationFrame(scanFrame);
        scanFrame = 0;
      }
      pendingRoots.clear();
    }

    const code = needsReload ? "EXTENSION_RELOADED" : "BACKGROUND_DISCONNECTED";
    logInfo(traceId, "content.runtime.interrupted", { code });
    if (state) {
      renderState(state, "error", {
        code,
        message: needsReload
          ? "확장이 다시 로드되었거나 연결이 해제되었습니다. Discord 페이지를 새로고침해 주세요."
          : "번역 응답을 기다리는 중 연결이 끊겼습니다. 다시 시도해 주세요.",
        traceId
      });
      if (!needsReload) {
        // Chromium can reject the pending response just before invalidating the content context.
        setTimeout(() => {
          if (state.host.isConnected && state.status === "error" &&
              state.translationHost.dataset.traceId === traceId && !isRuntimeAvailable()) {
            handleRuntimeInterruption(state, null, traceId);
          }
        }, 0);
      }
    }
    return true;
  }

  function getMessageContent(container) {
    const candidates = Array.from(container.querySelectorAll('[id^="message-content-"]'));
    const labelledContentId = (container.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .find((id) => id.startsWith("message-content-"));

    if (labelledContentId) {
      const labelledContent = candidates.find((candidate) => candidate.id === labelledContentId);

      if (labelledContent && !labelledContent.closest(`[${UI_ATTRIBUTE}]`)) {
        return labelledContent;
      }
    }

    const mainContents = Array.from(container.children).find((child) =>
      child.matches?.('[class*="contents_"]')
    );

    for (const selector of CONTENT_SELECTORS) {
      const content = mainContents?.querySelector(selector);

      if (content && !content.closest(`[${UI_ATTRIBUTE}]`)) {
        return content;
      }
    }

    for (const content of candidates) {
      const isReplyPreview = content.closest('[id^="message-reply-context-"]');

      if (!isReplyPreview && !content.closest(`[${UI_ATTRIBUTE}]`)) {
        return content;
      }
    }

    return null;
  }

  function getMessageId(container) {
    return (
      container.id ||
      container.getAttribute("data-list-item-id") ||
      `anonymous-${Shared.hashText(container.textContent || "")}`
    );
  }

  function createProtectedValue(context, value) {
    const token = `__DTX_${context.values.length}__`;
    context.values.push({ token, value });
    return token;
  }

  function serializeNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;

    if (element.hasAttribute(UI_ATTRIBUTE) || element.matches("script, style, button")) {
      return "";
    }

    if (element.tagName === "BR") {
      return "\n";
    }

    if (element.tagName === "IMG") {
      return element.getAttribute("alt") || element.getAttribute("aria-label") || "";
    }

    if (element.matches("pre, code")) {
      const code = Shared.normalizeWhitespace(element.textContent || "");
      return code ? createProtectedValue(context, code) : "";
    }

    if (element.tagName === "A") {
      const label = Shared.normalizeWhitespace(element.textContent || "");
      const href = element.getAttribute("href") || "";

      if (/^https?:\/\//i.test(href) && label && (label === href || /^https?:\/\//i.test(label))) {
        return createProtectedValue(context, label);
      }
    }

    let output = "";
    const isBlock = BLOCK_ELEMENTS.has(element.tagName);

    if (isBlock) {
      output += "\n";
    }

    for (const child of element.childNodes) {
      output += serializeNode(child, context);
    }

    if (isBlock) {
      output += "\n";
    }

    return output;
  }

  function protectRawUrls(text, context) {
    return text.replace(/https?:\/\/[^\s]+/gi, (url) => createProtectedValue(context, url));
  }

  function extractMessage(content) {
    const clone = content.cloneNode(true);
    const context = { values: [] };
    clone.querySelectorAll(`[${UI_ATTRIBUTE}]`).forEach((node) => node.remove());

    let text = Shared.normalizeWhitespace(serializeNode(clone, context));
    text = protectRawUrls(text, context);

    return {
      text,
      protectedValues: context.values,
      signature: `${text}\u0000${context.values.map((entry) => entry.value).join("\u0000")}`
    };
  }

  function restoreProtectedValues(text, values) {
    let restored = text;

    for (const entry of values) {
      restored = restored.split(entry.token).join(entry.value);
    }

    return restored;
  }

  function renderState(state, nextState, payload = {}) {
    state.status = nextState;
    state.button.dataset.state = nextState;
    state.panel.dataset.state = nextState;
    state.translationHost.dataset.state = nextState;
    state.translationHost.dataset.translatedLength =
      nextState === "success" ? String(payload.text?.length || 0) : "0";

    if (payload.traceId) {
      state.translationHost.dataset.traceId = payload.traceId;
    }
    state.action.hidden = true;
    state.retry.hidden = nextState !== "success";
    state.retry.disabled = nextState === "loading";
    state.action.disabled = nextState === "loading";
    state.button.disabled = nextState === "loading";

    if (nextState === "idle") {
      state.translationHost.remove();
      state.panel.hidden = true;
      state.button.setAttribute("aria-pressed", "false");
      state.button.title = "한국어로 번역";
      state.button.setAttribute("aria-label", "한국어로 번역");
      return;
    }

    if (!state.translationHost.isConnected) {
      state.content.insertAdjacentElement("afterend", state.translationHost);
    }
    state.panel.hidden = false;

    if (nextState === "loading") {
      state.body.textContent = "번역 중…";
      state.button.title = "번역 중";
      state.button.setAttribute("aria-label", "번역 중");
      state.button.setAttribute("aria-pressed", "false");
      return;
    }

    if (nextState === "success") {
      state.body.textContent = payload.text || "";
      state.button.title = "번역 숨기기";
      state.button.setAttribute("aria-label", "한국어 번역 숨기기");
      state.button.setAttribute("aria-pressed", "true");
      return;
    }

    const errorCode = payload.code || "UNKNOWN_ERROR";
    const traceSuffix = payload.traceId ? ` · ${payload.traceId}` : "";
    state.body.textContent = `${payload.message || "번역하지 못했습니다."} [${errorCode}${traceSuffix}]`;
    state.button.title = "번역 다시 시도";
    state.button.setAttribute("aria-label", "번역 다시 시도");
    state.button.setAttribute("aria-pressed", "false");
    state.action.hidden = false;
    if (errorCode === "EXTENSION_RELOADED") {
      state.action.dataset.action = "reload";
      state.action.textContent = "Discord 새로고침";
      state.button.disabled = true;
      state.button.title = "Discord 페이지를 새로고침해 주세요";
      state.button.setAttribute("aria-label", "Discord 페이지 새로고침 필요");
      return;
    }
    const settingsErrors = new Set([
      "CONFIG_REQUIRED",
      "MODEL_REQUIRED",
      "INVALID_MODEL",
      "INVALID_ENDPOINT",
      "INVALID_API_KEY",
      "INSECURE_API_KEY_ENDPOINT",
      "PROVIDER_PERMISSION_MISSING",
      "API_UNREACHABLE",
      "API_AUTH_ERROR",
      "API_ENDPOINT_NOT_FOUND",
      "MODEL_NOT_FOUND",
      "OPTIONS_PAGE_OPEN_FAILED"
    ]);
    state.action.dataset.action = settingsErrors.has(payload.code) ? "settings" : "retry";
    state.action.textContent = state.action.dataset.action === "settings" ? "설정 열기" : "다시 시도";
  }

  function cacheGet(key) {
    if (!translationCache.has(key)) {
      return null;
    }

    const value = translationCache.get(key);
    translationCache.delete(key);
    translationCache.set(key, value);
    return value;
  }

  function cacheSet(key, value) {
    if (translationCache.has(key)) {
      translationCache.delete(key);
    }

    translationCache.set(key, value);

    if (translationCache.size > CACHE_LIMIT) {
      translationCache.delete(translationCache.keys().next().value);
    }
  }

  async function translateState(state, requestedTraceId, { force = false } = {}) {
    const traceId = requestedTraceId || createTraceId();
    if (!isRuntimeAvailable()) {
      handleRuntimeInterruption(state, null, traceId);
      return;
    }
    if (state.status === "loading") {
      return;
    }
    const extraction = extractMessage(state.content);

    if (!extraction.text) {
      logInfo(traceId, "content.empty", { messageKey: Shared.hashText(state.messageId) });
      renderState(state, "error", {
        code: "EMPTY_TEXT",
        message: "번역할 텍스트가 없습니다.",
        traceId
      });
      return;
    }

    const sourceHash = Shared.hashText(extraction.signature);
    const cacheKey = createCacheKey(state.messageId, sourceHash);
    if (force) {
      translationCache.delete(cacheKey);
    }
    const cached = cacheGet(cacheKey);

    if (state.cacheKey !== cacheKey) {
      unregisterActiveState(state);
    }

    state.sourceHash = sourceHash;
    state.cacheKey = cacheKey;
    registerActiveState(state);
    state.requestVersion += 1;
    const requestVersion = state.requestVersion;

    logInfo(traceId, "content.request.start", {
      messageKey: Shared.hashText(state.messageId),
      sourceHash,
      textLength: extraction.text.length,
      protectedValueCount: extraction.protectedValues.length,
      requestVersion
    });

    if (cached) {
      logInfo(traceId, "content.cache.hit", {
        sourceHash,
        translatedLength: cached.length
      });
      renderState(state, "success", { text: cached, traceId });
      return;
    }

    latestRequests.set(cacheKey, traceId);
    renderState(state, "loading", { traceId });

    try {
      const response = await extensionApi.runtime.sendMessage({
        type: "TRANSLATE_MESSAGE",
        requestId: traceId,
        payload: { text: extraction.text }
      });

      if (latestRequests.get(cacheKey) !== traceId) {
        logInfo(traceId, "content.response.discarded", { reason: "newer-request" });
        return;
      }

      logInfo(traceId, "content.response.received", {
        ok: response?.ok === true,
        errorCode: response?.error?.code,
        model: response?.result?.model,
        translatedLength: response?.result?.translatedText?.length
      });

      if (!response?.ok) {
        const responseError = response?.error || {
          code: "INVALID_BACKGROUND_RESPONSE",
          message: "확장 백그라운드가 올바른 응답을 반환하지 않았습니다."
        };
        console.error(`${LOG_PREFIX} [${traceId}] content.response.error`, responseError);
        const activeState = getActiveState(cacheKey, sourceHash);

        if (activeState) {
          renderState(activeState, "error", { ...responseError, traceId });
        } else {
          logInfo(traceId, "content.response.discarded", { reason: "no-active-ui-for-error" });
        }
        return;
      }

      if (typeof response?.result?.translatedText !== "string") {
        const invalidResponse = {
          code: "INVALID_BACKGROUND_RESPONSE",
          message: "확장 백그라운드 응답에 번역문이 없습니다."
        };
        console.error(`${LOG_PREFIX} [${traceId}] content.response.invalid`, response);
        const activeState = getActiveState(cacheKey, sourceHash);

        if (activeState) {
          renderState(activeState, "error", { ...invalidResponse, traceId });
        }
        return;
      }

      const translatedText = restoreProtectedValues(
        response.result.translatedText,
        extraction.protectedValues
      );

      cacheSet(cacheKey, translatedText);
      const activeState = getActiveState(cacheKey, sourceHash);

      if (!activeState) {
        logInfo(traceId, "content.result.cached", {
          reason: "no-active-ui",
          translatedLength: translatedText.length
        });
        return;
      }

      const activeExtraction = extractMessage(activeState.content);
      const activeHash = Shared.hashText(activeExtraction.signature);

      if (activeHash !== sourceHash) {
        logInfo(traceId, "content.response.discarded", { reason: "active-message-edited" });
        return;
      }

      renderState(activeState, "success", { text: translatedText, traceId });
      logInfo(traceId, "content.request.success", {
        translatedLength: translatedText.length,
        rebound: activeState !== state
      });
    } catch (error) {
      const activeState = getActiveState(cacheKey, sourceHash);
      const currentState = requestVersion === state.requestVersion && latestRequests.get(cacheKey) === traceId
        ? activeState : null;

      if (handleRuntimeInterruption(currentState, error, traceId)) {
        return;
      }
      logError(traceId, "content.runtime.failed", error);

      if (currentState) {
        renderState(currentState, "error", {
          code: "EXTENSION_ERROR",
          message: "번역 요청을 처리하지 못했습니다. 다시 시도하거나 Discord 페이지를 새로고침해 주세요.",
          traceId
        });
      }
    } finally {
      if (latestRequests.get(cacheKey) === traceId) {
        latestRequests.delete(cacheKey);
      }
    }
  }

  function toggleTranslation(state, traceId = createTraceId()) {
    logInfo(traceId, "content.button.click", {
      messageKey: Shared.hashText(state.messageId),
      state: state.status
    });

    if (state.status !== "success") {
      translateState(state, traceId);
      return;
    }

    state.panel.hidden = !state.panel.hidden;
    const visible = !state.panel.hidden;
    state.button.setAttribute("aria-pressed", String(visible));
    state.button.title = visible ? "번역 숨기기" : "번역 보기";
    state.button.setAttribute("aria-label", visible ? "한국어 번역 숨기기" : "한국어 번역 보기");
    logInfo(traceId, "content.translation.toggle", { visible });
  }

  async function openSettings(state, traceId) {
    if (!isRuntimeAvailable()) {
      handleRuntimeInterruption(state, null, traceId);
      return;
    }
    logInfo(traceId, "content.settings.open.start", { errorState: state.status });
    state.action.disabled = true;
    state.action.textContent = "설정 여는 중…";

    try {
      const response = await extensionApi.runtime.sendMessage({
        type: "OPEN_OPTIONS_PAGE",
        requestId: traceId
      });

      if (!response?.ok) {
        throw Shared.createError(
          response?.error?.code || "OPTIONS_PAGE_OPEN_FAILED",
          response?.error?.message || "설정 페이지를 열지 못했습니다."
        );
      }

      logInfo(traceId, "content.settings.open.success", {
        method: response.result?.method
      });
    } catch (error) {
      if (handleRuntimeInterruption(state, error, traceId)) {
        return;
      }
      logError(traceId, "content.settings.open.failed", error);
      const serialized = Shared.serializeError(error);
      renderState(state, "error", {
        code:
          serialized.code === "UNKNOWN_ERROR"
            ? "OPTIONS_PAGE_OPEN_FAILED"
            : serialized.code,
        message:
          serialized.code === "UNKNOWN_ERROR"
            ? "설정 페이지를 열지 못했습니다. 확장 아이콘을 눌러 설정을 열어 주세요."
            : serialized.message,
        traceId
      });
    } finally {
      state.action.disabled = false;

      if (state.action.dataset.action === "settings") {
        state.action.textContent = "설정 열기";
      }
    }
  }

  function bindMessage(container) {
    const content = getMessageContent(container);

    if (!content) {
      return;
    }

    const extraction = extractMessage(content);

    if (!extraction.text) {
      return;
    }

    const sourceHash = Shared.hashText(extraction.signature);
    const existingState = messageStates.get(container);

    if (
      existingState &&
      existingState.content === content &&
      existingState.host.isConnected &&
      (existingState.status === "idle" || existingState.translationHost.isConnected)
    ) {
      Ui.applyButtonSettings(existingState.button, uiSettings);
      Ui.applyTranslationSettings(existingState.translationHost, uiSettings);
      if (existingState.sourceHash !== sourceHash) {
        unregisterActiveState(existingState);
        existingState.sourceHash = sourceHash;
        existingState.cacheKey = createCacheKey(existingState.messageId, sourceHash);
        existingState.requestVersion += 1;
        registerActiveState(existingState);
        const cached = cacheGet(existingState.cacheKey);
        renderState(existingState, cached ? "success" : "idle", cached ? { text: cached } : {});
      }
      return;
    }

    container.querySelectorAll(`[${UI_ATTRIBUTE}]`).forEach((node) => node.remove());

    const buttonUi = Ui.createButtonHost(uiSettings);
    const translationUi = Ui.createTranslationHost(uiSettings);
    content.append(buttonUi.host);

    const messageId = getMessageId(container);
    const cacheKey = createCacheKey(messageId, sourceHash);
    const previousState = activeStatesByCacheKey.get(cacheKey);
    const state = {
      messageId,
      cacheKey,
      content,
      host: buttonUi.host,
      translationHost: translationUi.host,
      button: buttonUi.button,
      panel: translationUi.panel,
      body: translationUi.body,
      action: translationUi.action,
      retry: translationUi.retry,
      sourceHash,
      requestVersion: 0,
      status: "idle"
    };

    buttonUi.button.addEventListener("click", () => toggleTranslation(state));
    translationUi.retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const traceId = createTraceId();
      logInfo(traceId, "content.retry.click", { messageKey: Shared.hashText(state.messageId) });
      translateState(state, traceId, { force: true });
    });
    translationUi.action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const traceId = createTraceId();

      if (translationUi.action.dataset.action === "reload") {
        window.location.reload();
      } else if (translationUi.action.dataset.action === "settings") {
        openSettings(state, traceId);
      } else {
        logInfo(traceId, "content.retry.click", { messageKey: Shared.hashText(state.messageId) });
        translateState(state, traceId, { force: true });
      }
    });

    messageStates.set(container, state);
    registerActiveState(state);
    const cached = cacheGet(cacheKey);

    if (cached) {
      renderState(state, "success", { text: cached });
    } else if (previousState?.status === "loading") {
      renderState(state, "loading");
      logInfo(createTraceId(), "content.ui.rebound", {
        messageKey: Shared.hashText(messageId),
        sourceHash,
        previousState: previousState.status
      });
    } else {
      renderState(state, "idle");
    }
  }

  function collectMessages(root) {
    const containers = new Set();
    const element = root?.nodeType === Node.ELEMENT_NODE ? root : root?.parentElement;

    if (!element) {
      return containers;
    }

    if (element.matches?.(MESSAGE_SELECTOR)) {
      containers.add(element);
    }

    element.querySelectorAll?.(MESSAGE_SELECTOR).forEach((container) => containers.add(container));

    const parentMessage = element.closest?.(MESSAGE_SELECTOR);
    if (parentMessage) {
      containers.add(parentMessage);
    }

    return containers;
  }

  function flushScans() {
    scanFrame = 0;

    const messages = new Set();

    for (const root of pendingRoots) {
      collectMessages(root).forEach((message) => messages.add(message));
    }

    pendingRoots.clear();
    messages.forEach(bindMessage);
  }

  function scheduleScan(root) {
    if (extensionInvalidated) {
      return;
    }
    pendingRoots.add(root || document.body);

    if (!scanFrame) {
      scanFrame = requestAnimationFrame(flushScans);
    }
  }

  async function startTranslator() {
    try {
      const stored = await extensionApi.storage.local.get("uiSettings");
      uiSettings = Shared.sanitizeUiSettings(stored.uiSettings);
    } catch (error) {
      if (handleRuntimeInterruption(null, error, createTraceId())) {
        return;
      }
      console.error(`${LOG_PREFIX} content.settings.load.failed`, error);
    }
    if (!isRuntimeAvailable()) {
      handleRuntimeInterruption(null, null, createTraceId());
      return;
    }
    console.info(`${LOG_PREFIX} content.ready`, {
      version: extensionApi.runtime.getManifest?.().version || "unknown",
      targetLanguage: uiSettings.targetLanguage
    });
    scheduleScan(document.body);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        scheduleScan(mutation.target);
        mutation.addedNodes.forEach(scheduleScan);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  extensionApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes.providerSettings) {
      translationCache.clear();
    }
    if (changes.uiSettings) {
      uiSettings = Shared.sanitizeUiSettings(changes.uiSettings.newValue);
      scheduleScan(document.body);
    }
  });

  startTranslator();
})();
