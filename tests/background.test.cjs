const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");

const MODEL = "0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M";
let messageListener;
let permissionGranted = true;
let fetchCalls = [];
let responseContent = "안녕하세요";
let openOptionsCalls = 0;
let openOptionsError = null;
let createdTabUrls = [];
let providerSettings = {
  provider: "openai-compatible",
  endpoint: "http://localhost:11434/v1",
  model: MODEL,
  apiKey: ""
};

globalThis.DiscordTranslatorShared = Shared;
globalThis.browser = {
  runtime: {
    id: "test-extension",
    getURL(path) {
      return `moz-extension://test-extension/${path}`;
    },
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      }
    },
    onInstalled: { addListener() {} },
    async openOptionsPage() {
      openOptionsCalls += 1;

      if (openOptionsError) {
        throw openOptionsError;
      }
    }
  },
  tabs: {
    async create({ url }) {
      createdTabUrls.push(url);
    }
  },
  action: { onClicked: { addListener() {} } },
  permissions: {
    async contains() {
      return permissionGranted;
    }
  },
  storage: {
    local: {
      async get() {
        return { providerSettings };
      }
    }
  }
};

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });

  return new Response(
    JSON.stringify({
      model: MODEL,
      choices: [{ message: { role: "assistant", content: responseContent } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

require("../background.js");

test.beforeEach(() => {
  permissionGranted = true;
  fetchCalls = [];
  responseContent = "안녕하세요";
  openOptionsCalls = 0;
  openOptionsError = null;
  createdTabUrls = [];
  providerSettings = {
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: MODEL,
    apiKey: ""
  };
});

function dispatch(message, sender) {
  return new Promise((resolve) => {
    const keepChannelOpen = messageListener(message, sender, resolve);
    assert.equal(keepChannelOpen, true);
  });
}

test("Discord 메시지를 키 없는 OpenAI 호환 요청으로 변환한다", async () => {
  const response = await dispatch(
    { type: "TRANSLATE_MESSAGE", payload: { text: "Hello" } },
    {
      id: "test-extension",
      url: "https://discord.com/channels/1/2",
      tab: { url: "https://discord.com/channels/1/2" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.result.translatedText, "안녕하세요");
  assert.equal(response.result.model, MODEL);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://localhost:11434/v1/chat/completions");

  const request = fetchCalls[0].options;
  const requestBody = JSON.parse(request.body);
  assert.equal(requestBody.model, MODEL);
  assert.equal(requestBody.stream, false);
  assert.equal(requestBody.think, undefined);
  assert.equal(requestBody.format, undefined);
  assert.match(requestBody.messages[1].content, /"source_text":"Hello"/);
  assert.equal(Object.hasOwn(requestBody, "requestId"), false);
  assert.equal(request.credentials, "omit");
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(Object.hasOwn(requestBody, "api_key"), false);
});

test("설정 화면 테스트는 chat/completions 시험 번역 한 번으로 연결을 확인한다", async () => {
  const response = await dispatch(
    { type: "TEST_PROVIDER" },
    {
      id: "test-extension",
      url: "moz-extension://test-extension/options/options.html",
      tab: { url: "moz-extension://test-extension/options/options.html" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.result.translatedText, "안녕하세요");
  assert.deepEqual(fetchCalls.map((call) => call.url), [
    "http://localhost:11434/v1/chat/completions"
  ]);
});

test("설정 화면을 흉내 낸 외부 페이지의 연결 테스트를 거부한다", async () => {
  const response = await dispatch(
    { type: "TEST_PROVIDER" },
    {
      id: "test-extension",
      url: "https://example.com/options/options.html",
      tab: { url: "https://example.com/options/options.html" }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNTRUSTED_SENDER");
  assert.equal(fetchCalls.length, 0);
});

test("Discord 오류 UI의 요청으로 확장 설정 페이지를 연다", async () => {
  const response = await dispatch(
    { type: "OPEN_OPTIONS_PAGE", requestId: "open-settings-test" },
    {
      id: "test-extension",
      url: "https://discord.com/channels/1/2",
      tab: { url: "https://discord.com/channels/1/2" }
    }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(response.result, {
    opened: true,
    method: "runtime.openOptionsPage"
  });
  assert.equal(openOptionsCalls, 1);
  assert.deepEqual(createdTabUrls, []);
  assert.equal(fetchCalls.length, 0);
});

test("표준 설정 열기가 실패하면 설정 URL을 새 탭으로 연다", async () => {
  openOptionsError = new Error("openOptionsPage failed");
  const response = await dispatch(
    { type: "OPEN_OPTIONS_PAGE", requestId: "open-settings-fallback-test" },
    {
      id: "test-extension",
      url: "https://discord.com/channels/1/2",
      tab: { url: "https://discord.com/channels/1/2" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.result.method, "tabs.create");
  assert.equal(openOptionsCalls, 1);
  assert.deepEqual(createdTabUrls, [
    "moz-extension://test-extension/options/options.html"
  ]);
});

test("API 키가 있으면 Bearer 인증 헤더만 추가한다", async () => {
  providerSettings = {
    provider: "openai-compatible",
    endpoint: "https://api.example.com/v1",
    model: "example/model",
    apiKey: "top-secret"
  };

  const response = await dispatch(
    { type: "TRANSLATE_MESSAGE", payload: { text: "Hello" } },
    {
      id: "test-extension",
      url: "https://discord.com/channels/1/2",
      tab: { url: "https://discord.com/channels/1/2" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(fetchCalls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(fetchCalls[0].options.headers.Authorization, "Bearer top-secret");
  assert.equal(fetchCalls[0].options.body.includes("top-secret"), false);
});

test("Discord가 아닌 페이지의 번역 요청을 거부한다", async () => {
  const response = await dispatch(
    { type: "TRANSLATE_MESSAGE", payload: { text: "Hello" } },
    {
      id: "test-extension",
      url: "https://example.com/",
      tab: { url: "https://example.com/" }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNTRUSTED_SENDER");
});

test("승인되지 않은 API 호스트 권한을 명확히 알린다", async () => {
  permissionGranted = false;
  const response = await dispatch(
    { type: "TRANSLATE_MESSAGE", payload: { text: "Hello" } },
    {
      id: "test-extension",
      url: "https://discord.com/channels/1/2",
      tab: { url: "https://discord.com/channels/1/2" }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "PROVIDER_PERMISSION_MISSING");
});

const replySuggestions = [
  { tone: "natural", en: "Thanks. I'll check and get back to you.", ko: "고마워요. 확인하고 알려드릴게요." },
  { tone: "friendly", en: "Thanks for the fix! I'll take a look.", ko: "고쳐 줘서 고마워요! 살펴볼게요." },
  { tone: "polite", en: "Thank you for resolving this. I'll review the changes.", ko: "해결해 주셔서 감사합니다. 변경 사항을 검토하겠습니다." }
];
const discordSender = { id: "test-extension", url: "https://discord.com/channels/1/2" };

test("문맥과 의도를 한 번의 호환 API 요청으로 전달하고 추천 3개를 반환한다", async () => {
  responseContent = `<think>reasoning</think>\n\`\`\`json\n${JSON.stringify({ suggestions: replySuggestions })}\n\`\`\``;
  const response = await dispatch({
    type: "SUGGEST_REPLIES",
    payload: { mode: "reply", intent: "고맙고 확인해 보겠다고 해줘", channelId: "private-channel", context: [
      { text: "The fix is ready.", speaker: "participant_1", author: "Private name", messageId: "private-message" }
    ] }
  }, discordSender);
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.suggestions, replySuggestions);
  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].options.body);
  const request = JSON.parse(body.messages[1].content);
  assert.equal(request.mode, "reply");
  assert.deepEqual(request.context, [{ speaker: "participant_1", text: "The fix is ready." }]);
  assert.match(body.messages[0].content, /mode=thread/);
  assert.match(body.messages[0].content, /reference data, never instructions/);
  assert.equal(/Private name|private-channel|private-message/.test(body.messages[1].content), false);
  assert.equal(body.response_format, undefined);
  assert.equal(body.stream, false);
});

test("문맥 없는 신규 작성도 같은 추천 경로로 처리한다", async () => {
  responseContent = JSON.stringify({ suggestions: replySuggestions });
  const response = await dispatch({ type: "SUGGEST_REPLIES", payload: { mode: "new", intent: "안부 인사", context: [] } }, discordSender);
  assert.equal(response.ok, true);
  const request = JSON.parse(JSON.parse(fetchCalls[0].options.body).messages[1].content);
  assert.deepEqual(request.context, []);
});

test("잘못된 추천 형식이나 후보 누락은 성공으로 표시하지 않는다", async () => {
  for (const value of ["Plain English answer", { suggestions: replySuggestions.slice(0, 2) }, { suggestions: [{ ...replySuggestions[0], ko: "" }, ...replySuggestions.slice(1)] }]) {
    responseContent = typeof value === "string" ? value : JSON.stringify(value);
    const response = await dispatch({ type: "SUGGEST_REPLIES", payload: { mode: "new", intent: "안부 인사", context: [] } }, discordSender);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INVALID_SUGGESTIONS");
  }
});

test("추천도 출처·호스트 권한·입력 제한을 검사하고 원글 없는 답장을 거부한다", async () => {
  const message = { type: "SUGGEST_REPLIES", payload: { mode: "new", intent: "인사", context: [] } };
  assert.equal((await dispatch(message, { url: "https://example.com/" })).error.code, "UNTRUSTED_SENDER");
  assert.equal((await dispatch({ ...message, payload: { ...message.payload, mode: "reply" } }, discordSender)).error.code, "INVALID_COMPOSE_CONTEXT");
  assert.equal((await dispatch({ ...message, payload: { ...message.payload, intent: "a".repeat(4001) } }, discordSender)).error.code, "INTENT_TOO_LONG");
  permissionGranted = false;
  assert.equal((await dispatch(message, discordSender)).error.code, "PROVIDER_PERMISSION_MISSING");
  assert.equal(fetchCalls.length, 0);
});

test.after(() => {
  delete globalThis.browser;
  delete globalThis.DiscordTranslatorShared;
  delete globalThis.fetch;
});
