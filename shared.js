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
    targetLanguage: "ko",
    buttonIcon: "hangul",
    translationTheme: "default"
  });

  const BUTTON_ICONS = Object.freeze([
    Object.freeze({ id: "hangul", label: "한글", markup: "한" }),
    Object.freeze({ id: "translate", label: "가/A", markup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h12M9 3v2m3 0c-1 6-4 9-9 12m2-9c1 3 4 6 8 8m1 5 4-11 4 11m-6.5-4h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
    Object.freeze({ id: "globe", label: "지구본", markup: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></g></svg>' }),
    Object.freeze({ id: "bubble", label: "말풍선", markup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4H4v13h4v4l5-4h7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 8h10M7 12h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' })
  ]);

  const TRANSLATION_THEMES = Object.freeze([
    Object.freeze({ id: "default", label: "기본", color: "var(--text-muted, #b5bac1)", background: "transparent", accent: "#54e2d1" }),
    Object.freeze({ id: "mint", label: "민트", color: "#c9f7ed", background: "#183c36", accent: "#77e2c5" }),
    Object.freeze({ id: "blue", label: "블루", color: "#d6e8ff", background: "#203653", accent: "#91c2ff" }),
    Object.freeze({ id: "lavender", label: "라벤더", color: "#eee0ff", background: "#3b2c50", accent: "#cdb0ff" }),
    Object.freeze({ id: "amber", label: "앰버", color: "#ffe9bd", background: "#46351c", accent: "#f4c974" })
  ]);

  const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: DEFAULT_LLM_MODEL,
    apiKey: ""
  });

  const MAX_TEXT_LENGTH = 10_000;
  const COMPOSER_LIMITS = Object.freeze({ intent: 4_000, context: 16_000, messages: 12 });
  const REPLY_TONES = Object.freeze([
    Object.freeze({ id: "natural", label: "자연스럽게" }),
    Object.freeze({ id: "friendly", label: "친근하게" }),
    Object.freeze({ id: "polite", label: "정중하게" })
  ]);

  // Keep local message/channel IDs and display names out of the provider payload.
  function sanitizeComposeRequest(value) {
    const mode = value?.mode;
    if (!["new", "reply", "thread"].includes(mode)) {
      throw createError("INVALID_COMPOSE_REQUEST", "작성 상황을 확인하지 못했습니다. 작성 창을 다시 열어 주세요.");
    }
    const intent = typeof value.intent === "string" ? value.intent.trim() : "";
    if (!intent) {
      throw createError("EMPTY_INTENT", "전달할 내용이나 의도를 한국어로 작성해 주세요.");
    }
    if (intent.length > COMPOSER_LIMITS.intent) {
      throw createError("INTENT_TOO_LONG", `작성할 내용은 ${COMPOSER_LIMITS.intent.toLocaleString("ko-KR")}자까지 입력할 수 있습니다.`);
    }
    if (!Array.isArray(value.context) || value.context.length > COMPOSER_LIMITS.messages) {
      throw createError("CONTEXT_TOO_LONG", `참고할 대화는 ${COMPOSER_LIMITS.messages}개까지 선택할 수 있습니다.`);
    }
    if ((mode === "new" && value.context.length !== 0) ||
        (mode === "reply" && value.context.length !== 1) ||
        (mode === "thread" && value.context.length === 0)) {
      throw createError("INVALID_COMPOSE_CONTEXT", "답장 원글 또는 참고할 대화를 확인해 주세요.");
    }
    const context = value.context.map((entry) => {
      if (typeof entry?.text !== "string" || !entry.text.trim()) {
        throw createError("CONTEXT_UNAVAILABLE", "참고할 글의 본문을 확인할 수 없습니다. 원글을 불러온 뒤 다시 선택해 주세요.");
      }
      return {
        speaker: /^participant_\d{1,2}$/.test(entry.speaker) ? entry.speaker : "participant_1",
        text: entry.text.trim()
      };
    });
    if (context.reduce((length, entry) => length + entry.text.length, 0) > COMPOSER_LIMITS.context) {
      throw createError("CONTEXT_TOO_LONG", `참고 대화가 ${COMPOSER_LIMITS.context.toLocaleString("ko-KR")}자를 넘습니다. 선택한 글을 줄여 주세요.`);
    }
    return { mode, intent, context };
  }

  function validateReplySuggestions(value) {
    const fail = () => createError("INVALID_SUGGESTIONS", "영어와 한국어가 짝을 이룬 추천 3개를 받지 못했습니다. 다시 추천해 주세요.");
    if (!Array.isArray(value) || value.length !== REPLY_TONES.length) throw fail();
    const suggestions = REPLY_TONES.map(({ id }) => {
      const entries = value.filter((entry) => entry?.tone === id);
      const entry = entries[0];
      if (entries.length !== 1 || typeof entry?.en !== "string" || typeof entry?.ko !== "string" ||
          !entry.en.trim() || !entry.ko.trim() || entry.en.length > MAX_TEXT_LENGTH || entry.ko.length > MAX_TEXT_LENGTH) {
        throw fail();
      }
      return { tone: id, en: entry.en.trim(), ko: entry.ko.trim() };
    });
    const unique = new Set(suggestions.map((entry) => entry.en.toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "")));
    if (unique.size !== REPLY_TONES.length) throw fail();
    return suggestions;
  }

  function sanitizeUiSettings(value) {
    const candidate = value && typeof value === "object" ? value : {};
    return {
      targetLanguage: "ko",
      buttonIcon: BUTTON_ICONS.some((icon) => icon.id === candidate.buttonIcon)
        ? candidate.buttonIcon : DEFAULT_UI_SETTINGS.buttonIcon,
      translationTheme: TRANSLATION_THEMES.some((theme) => theme.id === candidate.translationTheme)
        ? candidate.translationTheme : DEFAULT_UI_SETTINGS.translationTheme
    };
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
    BUTTON_ICONS,
    TRANSLATION_THEMES,
    DEFAULT_PROVIDER_SETTINGS,
    MAX_TEXT_LENGTH,
    COMPOSER_LIMITS,
    REPLY_TONES,
    sanitizeComposeRequest,
    validateReplySuggestions,
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
