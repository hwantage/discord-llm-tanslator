const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");

const DEFAULT_MODEL = "0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M";

test("기본 실행은 WebLLM이고 Ollama 연결 기본값도 보관한다", () => {
  assert.deepEqual(Shared.DEFAULT_PROVIDER_SETTINGS, {
    provider: "webllm",
    webllmModelId: Shared.WEBLLM_MODEL_ID,
    endpoint: "http://localhost:11434/v1",
    model: DEFAULT_MODEL,
    apiKey: ""
  });
  assert.equal(Shared.WEBLLM_MODEL_ID, "Qwen2.5-7B-Instruct-q4f16_1-MLC");
  assert.deepEqual(Shared.sanitizeProviderSettings(), Shared.DEFAULT_PROVIDER_SETTINGS);
});

test("WebLLM과 API 사이를 전환해도 저장된 API 프로필은 유지한다", () => {
  const profile = { provider: "openai-compatible", webllmModelId: "SmolLM2-360M-Instruct-q4f16_1-MLC", endpoint: "https://api.example.com/v1", model: "saved/model", apiKey: "saved-key" };
  const local = Shared.sanitizeProviderSettings({ ...profile, provider: "webllm" });
  assert.deepEqual(local, { ...profile, provider: "webllm" });
  assert.deepEqual(Shared.sanitizeProviderSettings({ ...local, provider: "openai-compatible" }), profile);
});

test("로컬과 원격 OpenAI 호환 API 주소를 정규화한다", () => {
  assert.equal(
    Shared.normalizeApiEndpoint("http://localhost:11434/"),
    "http://localhost:11434"
  );
  assert.equal(
    Shared.normalizeApiEndpoint("https://api.openai.com/v1/"),
    "https://api.openai.com/v1"
  );
  assert.throws(
    () => Shared.normalizeApiEndpoint("file:///tmp/translator"),
    (error) => error.code === "INVALID_ENDPOINT"
  );
});

test("OpenAI chat/completions 경로를 중복 없이 만든다", () => {
  assert.equal(
    Shared.getChatCompletionsUrl("http://localhost:11434/v1"),
    "http://localhost:11434/v1/chat/completions"
  );
  assert.equal(
    Shared.getChatCompletionsUrl("https://openrouter.ai/api/v1/chat/completions"),
    "https://openrouter.ai/api/v1/chat/completions"
  );
});

test("WebExtension 호스트 권한 패턴에서는 포트를 제외한다", () => {
  assert.equal(
    Shared.getPermissionPattern("http://127.0.0.1:11434"),
    "http://127.0.0.1/*"
  );
  assert.equal(
    Shared.getPermissionPattern("https://api.example.com/v1"),
    "https://api.example.com/*"
  );
});

test("LLM 모델 이름과 태그를 검증한다", () => {
  assert.equal(Shared.normalizeModel(`  ${DEFAULT_MODEL}  `), DEFAULT_MODEL);
  assert.throws(
    () => Shared.normalizeModel("model name with spaces"),
    (error) => error.code === "INVALID_MODEL"
  );
});

test("API 키는 선택 사항이며 Bearer 접두사를 중복 저장하지 않는다", () => {
  assert.equal(Shared.normalizeApiKey(undefined), "");
  assert.equal(Shared.normalizeApiKey("  Bearer secret-key  "), "secret-key");
  assert.equal(Shared.isSecureApiKeyEndpoint("https://api.example.com/v1"), true);
  assert.equal(Shared.isSecureApiKeyEndpoint("http://localhost:11434/v1"), true);
  assert.equal(Shared.isSecureApiKeyEndpoint("http://api.example.com/v1"), false);
});

test("기존 LibreTranslate 설정은 안전한 기본값으로 마이그레이션한다", () => {
  assert.deepEqual(
    Shared.sanitizeProviderSettings({
      endpoint: "https://translate.example.com",
      apiKey: "legacy-secret"
    }),
    Shared.DEFAULT_PROVIDER_SETTINGS
  );
});

test("설정값을 보수적으로 정규화한다", () => {
  assert.deepEqual(Shared.sanitizeUiSettings({ enabled: false, targetLanguage: "ja" }), {
    targetLanguage: "ko",
    buttonIcon: "hangul",
    translationTheme: "default"
  });
  assert.deepEqual(
    Shared.sanitizeProviderSettings({
      provider: "openai-compatible",
      endpoint: "  https://api.example.com/v1  ",
      model: ` ${DEFAULT_MODEL} `,
      apiKey: " secret "
    }),
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      webllmModelId: Shared.WEBLLM_MODEL_ID,
      model: DEFAULT_MODEL,
      apiKey: "secret"
    }
  );
});

test("표시 설정은 지원하는 아이콘과 색상만 저장하고 잘못된 값은 기본값으로 되돌린다", () => {
  assert.deepEqual(Shared.sanitizeUiSettings({ buttonIcon: "globe", translationTheme: "blue" }), {
    targetLanguage: "ko", buttonIcon: "globe", translationTheme: "blue"
  });
  for (const value of [undefined, null, "mint", {}, { buttonIcon: "<script>", translationTheme: "url(https://example.com)" }]) {
    assert.deepEqual(Shared.sanitizeUiSettings(value), Shared.DEFAULT_UI_SETTINGS);
  }
  assert.deepEqual(Shared.sanitizeUiSettings({ buttonIcon: "bubble", translationTheme: "missing" }), {
    targetLanguage: "ko", buttonIcon: "bubble", translationTheme: "default"
  });
});

test("기존 Ollama 설정은 OpenAI 호환 /v1 엔드포인트로 마이그레이션한다", () => {
  assert.deepEqual(
    Shared.sanitizeProviderSettings({
      provider: "ollama",
      endpoint: "http://localhost:11434",
      model: DEFAULT_MODEL
    }),
    {
      provider: "openai-compatible",
      endpoint: "http://localhost:11434/v1",
      webllmModelId: Shared.WEBLLM_MODEL_ID,
      model: DEFAULT_MODEL,
      apiKey: ""
    }
  );
});

test("문자열 해시는 결정적이며 입력 변화에 반응한다", () => {
  assert.equal(Shared.hashText("hello"), Shared.hashText("hello"));
  assert.notEqual(Shared.hashText("hello"), Shared.hashText("hello!"));
});

test("추천 칸에 생략 부호만 있거나 영어·한국어가 빠진 결과는 거부한다", () => {
  const suggestions = [
    { tone: "natural", en: "Hello there.", ko: "안녕하세요." },
    { tone: "friendly", en: "Hey, nice to meet you!", ko: "안녕, 만나서 반가워요!" },
    { tone: "polite", en: "It is a pleasure to meet you.", ko: "만나 뵙게 되어 기쁩니다." }
  ];
  for (const invalid of [{ en: "..." }, { en: "안녕하세요" }, { ko: "Hello there." }]) {
    assert.throws(() => Shared.validateReplySuggestions([{ ...suggestions[0], ...invalid }, ...suggestions.slice(1)]),
      { code: "INVALID_SUGGESTIONS" });
  }
});

test("공백을 줄이되 줄바꿈은 보존한다", () => {
  assert.equal(
    Shared.normalizeWhitespace("  첫 줄   문장 \n\n\n 둘째 줄  "),
    "첫 줄 문장\n\n둘째 줄"
  );
});
