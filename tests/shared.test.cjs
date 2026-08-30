const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");

const DEFAULT_MODEL = "0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M";

test("기본 설정은 키 없는 로컬 Ollama OpenAI 호환 API를 사용한다", () => {
  assert.deepEqual(Shared.DEFAULT_PROVIDER_SETTINGS, {
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: DEFAULT_MODEL,
    apiKey: ""
  });
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
    targetLanguage: "ko"
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
      model: DEFAULT_MODEL,
      apiKey: "secret"
    }
  );
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
      model: DEFAULT_MODEL,
      apiKey: ""
    }
  );
});

test("문자열 해시는 결정적이며 입력 변화에 반응한다", () => {
  assert.equal(Shared.hashText("hello"), Shared.hashText("hello"));
  assert.notEqual(Shared.hashText("hello"), Shared.hashText("hello!"));
});

test("공백을 줄이되 줄바꿈은 보존한다", () => {
  assert.equal(
    Shared.normalizeWhitespace("  첫 줄   문장 \n\n\n 둘째 줄  "),
    "첫 줄 문장\n\n둘째 줄"
  );
});
