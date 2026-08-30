(function initializeShared(root, factory) {
  const shared = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = shared;
  }

  if (root) {
    root.DiscordTranslatorShared = shared;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createShared() {
  "use strict";

  const DEFAULT_LLM_MODEL = "0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M";

  const DEFAULT_UI_SETTINGS = Object.freeze({
    targetLanguage: "ko"
  });

  const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: DEFAULT_LLM_MODEL,
    apiKey: ""
  });

  const MAX_TEXT_LENGTH = 10_000;

  function sanitizeUiSettings() {
    return { ...DEFAULT_UI_SETTINGS };
  }

  function sanitizeProviderSettings(value) {
    const candidate = value && typeof value === "object" ? value : {};
    const isLegacyLibreTranslate =
      candidate.provider !== "ollama" &&
      candidate.provider !== "openai-compatible" &&
      typeof candidate.model !== "string";
    let endpoint = DEFAULT_PROVIDER_SETTINGS.endpoint;
    let model = DEFAULT_LLM_MODEL;
    let apiKey = "";

    if (!isLegacyLibreTranslate && typeof candidate.endpoint === "string") {
      try {
        endpoint =
          candidate.provider === "ollama"
            ? migrateOllamaEndpoint(candidate.endpoint)
            : normalizeApiEndpoint(candidate.endpoint);
      } catch {
        endpoint = DEFAULT_PROVIDER_SETTINGS.endpoint;
      }
    }

    if (!isLegacyLibreTranslate && typeof candidate.model === "string") {
      try {
        model = normalizeModel(candidate.model);
      } catch {
        model = DEFAULT_LLM_MODEL;
      }
    }

    if (!isLegacyLibreTranslate) {
      try {
        apiKey = normalizeApiKey(candidate.apiKey);
      } catch {
        apiKey = "";
      }
    }

    return {
      provider: "openai-compatible",
      endpoint,
      model,
      apiKey
    };
  }

  function parseApiEndpoint(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw createError("CONFIG_REQUIRED", "OpenAI 호환 API 엔드포인트를 입력해 주세요.");
    }

    let url;

    try {
      url = new URL(value.trim());
    } catch {
      throw createError("INVALID_ENDPOINT", "올바른 HTTP 또는 HTTPS API 주소를 입력해 주세요.");
    }

    if (url.username || url.password) {
      throw createError("INVALID_ENDPOINT", "API 주소에 사용자명이나 비밀번호를 포함할 수 없습니다.");
    }

    const isSupportedProtocol = url.protocol === "http:" || url.protocol === "https:";

    if (!isSupportedProtocol) {
      throw createError("INVALID_ENDPOINT", "API 엔드포인트는 HTTP 또는 HTTPS 주소여야 합니다.");
    }

    url.search = "";
    url.hash = "";
    return url;
  }

  function normalizeApiEndpoint(value) {
    const url = parseApiEndpoint(value);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  }

  function migrateOllamaEndpoint(value) {
    const url = parseApiEndpoint(value);
    const cleanPath = url.pathname.replace(/\/+$/, "");

    if (!cleanPath || cleanPath === "/api") {
      url.pathname = "/v1";
    } else if (!cleanPath.endsWith("/v1")) {
      url.pathname = `${cleanPath}/v1`;
    }

    return normalizeApiEndpoint(url.toString());
  }

  function normalizeModel(value) {
    const model = typeof value === "string" ? value.trim() : "";

    if (!model) {
      throw createError("MODEL_REQUIRED", "사용할 LLM 모델 이름을 입력해 주세요.");
    }

    if (model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/:\-]*$/.test(model)) {
      throw createError("INVALID_MODEL", "LLM 모델 이름 형식이 올바르지 않습니다.");
    }

    return model;
  }

  function normalizeApiKey(value) {
    const apiKey = typeof value === "string" ? value.trim().replace(/^Bearer\s+/i, "") : "";

    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
      throw createError("INVALID_API_KEY", "API 키 형식이 올바르지 않습니다.");
    }

    return apiKey;
  }

  function getChatCompletionsUrl(value) {
    const url = parseApiEndpoint(value);
    const cleanPath = url.pathname.replace(/\/+$/, "");

    if (!cleanPath.endsWith("/chat/completions")) {
      const apiBase = cleanPath || "/v1";
      url.pathname = `${apiBase}/chat/completions`.replace(/^\/\//, "/");
    }

    return url.toString();
  }

  function getPermissionPattern(value) {
    const url = parseApiEndpoint(value);
    // WebExtension match patterns omit ports and grant the selected host.
    return `${url.protocol}//${url.hostname}/*`;
  }

  function isSecureApiKeyEndpoint(value) {
    const url = parseApiEndpoint(value);
    return (
      url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    );
  }

  function createError(code, message) {
    const error = new Error(message);
    error.name = "DiscordTranslatorError";
    error.code = code;
    return error;
  }

  function serializeError(error) {
    return {
      code: typeof error?.code === "string" ? error.code : "UNKNOWN_ERROR",
      message:
        typeof error?.message === "string" && error.message
          ? error.message
          : "번역 중 알 수 없는 오류가 발생했습니다."
    };
  }

  function hashText(value) {
    let hash = 0x811c9dc5;
    const text = String(value);

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(36);
  }

  function normalizeWhitespace(value) {
    return String(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return Object.freeze({
    DEFAULT_LLM_MODEL,
    DEFAULT_UI_SETTINGS,
    DEFAULT_PROVIDER_SETTINGS,
    MAX_TEXT_LENGTH,
    sanitizeUiSettings,
    sanitizeProviderSettings,
    normalizeApiEndpoint,
    normalizeModel,
    normalizeApiKey,
    getChatCompletionsUrl,
    getPermissionPattern,
    isSecureApiKeyEndpoint,
    createError,
    serializeError,
    hashText,
    normalizeWhitespace
  });
});
