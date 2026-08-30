(function initializeDiscordTranslator() {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const Shared = globalThis.DiscordTranslatorShared;
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
  const pendingRoots = new Set();
  const uiSettings = Shared.sanitizeUiSettings();
  let scanFrame = 0;
  let traceSequence = 0;

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

  function createButtonHost() {
    const host = document.createElement("span");
    host.setAttribute(UI_ATTRIBUTE, "button");
    host.setAttribute("contenteditable", "false");
    host.style.marginLeft = "5px";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          vertical-align: 0.04em;
        }

        button {
          appearance: none;
          width: 1.62em;
          height: 1.62em;
          display: inline-grid;
          place-items: center;
          border: 1px solid rgb(181 196 195 / 24%);
          border-radius: 5px;
          padding: 0;
          color: rgb(213 222 221 / 78%);
          background: rgb(78 89 91 / 28%);
          box-shadow: inset 0 1px 0 rgb(255 255 255 / 3%);
          font: 700 0.64em/1 ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif;
          cursor: pointer;
          opacity: 0.86;
          transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease, opacity 120ms ease, transform 120ms ease;
        }

        button:hover {
          border-color: rgb(84 226 209 / 45%);
          color: #d8fffa;
          background: rgb(84 226 209 / 9%);
          opacity: 1;
        }

        button:active {
          transform: scale(0.96);
        }

        button:focus-visible {
          outline: 2px solid #7cf0e3;
          outline-offset: 2px;
        }

        button[data-state="loading"] {
          animation: translator-pulse 900ms ease-in-out infinite alternate;
          cursor: progress;
        }

        button[aria-pressed="true"] {
          color: #c9f7f1;
          background: rgb(84 226 209 / 13%);
          border-color: rgb(84 226 209 / 42%);
          opacity: 1;
        }

        @keyframes translator-pulse {
          from { opacity: 0.48; }
          to { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          button { transition: none; }
          button[data-state="loading"] { animation: none; opacity: 0.65; }
        }
      </style>
      <button type="button" aria-label="한국어로 번역" aria-pressed="false" title="한국어로 번역">한</button>
    `;

    return { host, button: shadow.querySelector("button") };
  }

  function createTranslationHost() {
    const host = document.createElement("div");
    host.setAttribute(UI_ATTRIBUTE, "translation");
    host.dataset.state = "idle";
    host.setAttribute("contenteditable", "false");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          max-width: 100%;
          margin-top: 0.28rem;
          color: var(--text-normal, #dbdee1);
          font: inherit;
        }

        .translation {
          position: relative;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 0.48rem;
          align-items: start;
          box-sizing: border-box;
          width: 100%;
          max-width: none;
          padding-inline-start: 0.58rem;
        }

        .translation::before {
          content: "";
          position: absolute;
          inset-block: 0.16rem;
          inset-inline-start: 0;
          width: 2px;
          border-radius: 2px;
          background: #2ac9b7;
          opacity: 0.88;
        }

        .label {
          margin-top: 0.12rem;
          color: #54e2d1;
          font: 700 0.64rem/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.035em;
          user-select: none;
        }

        .body {
          min-width: 0;
          color: var(--text-muted, #b5bac1);
          font: inherit;
          line-height: 1.42;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .translation[data-state="loading"] .body {
          opacity: 0.64;
        }

        .translation[data-state="error"]::before {
          background: var(--status-danger, #f23f42);
        }

        .translation[data-state="error"] .label {
          color: var(--status-danger, #f23f42);
        }

        .action {
          grid-column: 2;
          justify-self: start;
          appearance: none;
          margin-top: 0.2rem;
          border: 0;
          padding: 0;
          color: #54e2d1;
          background: transparent;
          font: inherit;
          font-size: 0.74rem;
          font-weight: 650;
          line-height: 1.3;
          cursor: pointer;
        }

        .action:hover { text-decoration: underline; }
        .action:focus-visible { outline: 2px solid #7cf0e3; outline-offset: 2px; }
      </style>
      <div class="translation" role="status" aria-live="polite" hidden>
        <span class="label">KO</span>
        <span class="body"></span>
        <button class="action" type="button" hidden>다시 시도</button>
      </div>
    `;

    return {
      host,
      panel: shadow.querySelector(".translation"),
      body: shadow.querySelector(".body"),
      action: shadow.querySelector(".action")
    };
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

  async function translateState(state, requestedTraceId) {
    const traceId = requestedTraceId || createTraceId();
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

    renderState(state, "loading");

    try {
      const response = await extensionApi.runtime.sendMessage({
        type: "TRANSLATE_MESSAGE",
        requestId: traceId,
        payload: { text: extraction.text }
      });

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
      logError(traceId, "content.runtime.failed", error);
      const activeState = getActiveState(cacheKey, sourceHash);

      if (activeState && requestVersion === state.requestVersion) {
        renderState(activeState, "error", {
          code: "EXTENSION_ERROR",
          message: "확장 백그라운드에 연결하지 못했습니다. 확장을 다시 로드해 주세요.",
          traceId
        });
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

    const buttonUi = createButtonHost();
    const translationUi = createTranslationHost();
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
      sourceHash,
      requestVersion: 0,
      status: "idle"
    };

    buttonUi.button.addEventListener("click", () => toggleTranslation(state));
    translationUi.action.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const traceId = createTraceId();

      if (translationUi.action.dataset.action === "settings") {
        openSettings(state, traceId);
      } else {
        logInfo(traceId, "content.retry.click", { messageKey: Shared.hashText(state.messageId) });
        translateState(state, traceId);
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
    pendingRoots.add(root || document.body);

    if (!scanFrame) {
      scanFrame = requestAnimationFrame(flushScans);
    }
  }

  function startTranslator() {
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
  });

  startTranslator();
})();
