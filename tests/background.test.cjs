const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");

const MODEL = "0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M";
let messageListener;
let permissionGranted = true;
let fetchCalls = [];
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
      choices: [{ message: { role: "assistant", content: "안녕하세요" } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

require("../background.js");

test.beforeEach(() => {
  permissionGranted = true;
  fetchCalls = [];
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

test.after(() => {
  delete globalThis.browser;
  delete globalThis.DiscordTranslatorShared;
  delete globalThis.fetch;
});
