const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const Shared = require("../shared.js");

function element() {
  return {
    dataset: {}, attributes: {}, isConnected: true, hidden: false, disabled: false,
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { this.isConnected = false; }
  };
}

function messageContent(text) {
  return {
    nodeType: 1, tagName: "DIV", childNodes: [{ nodeType: 3, nodeValue: text }],
    cloneNode() { return messageContent(text); },
    querySelectorAll() { return []; },
    hasAttribute() { return false; },
    matches() { return false; },
    insertAdjacentElement(_position, host) { host.isConnected = true; }
  };
}

function harness() {
  const requests = [];
  const pending = [];
  const failures = [];
  const errors = [];
  let observerDisconnected = false;
  const context = {
    DiscordTranslatorShared: Shared,
    DiscordTranslatorUi: {},
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    document: { body: {} },
    MutationObserver: class { observe() {} disconnect() { observerDisconnected = true; } },
    cancelAnimationFrame() {},
    setTimeout,
    console: { info() {}, error(...args) { errors.push(args); } },
    chrome: {
      storage: { onChanged: { addListener() {} } },
      runtime: { id: "test-extension", sendMessage(message) {
        requests.push(message);
        return new Promise((resolve, reject) => { pending.push(resolve); failures.push(reject); });
      } }
    }
  };
  // Expose the content script's private request flow only inside this isolated test context.
  const source = readFileSync(require.resolve("../content.js"), "utf8").replace(
    "  startTranslator();",
    "  globalThis.testApi = { translateState, toggleTranslation, registerActiveState, openSettings };"
  );
  runInNewContext(source, context);
  return {
    ...context.testApi, requests, pending, failures, errors, runtime: context.chrome.runtime,
    isObserverDisconnected: () => observerDisconnected
  };
}

function state(text = "Hello https://example.com") {
  return {
    messageId: "message-1", content: messageContent(text),
    host: element(), translationHost: element(), button: element(), panel: element(),
    body: element(), action: element(), retry: element(),
    requestVersion: 0, status: "idle"
  };
}

const success = (translatedText) => ({ ok: true, result: { translatedText } });

test("재시도는 캐시를 건너뛰고 새 결과로 교체하며 일반 토글은 요청하지 않는다", async () => {
  const app = harness();
  const message = state();
  const initial = app.translateState(message);
  app.pending.shift()(success("첫 번역 __DTX_0__"));
  await initial;
  assert.equal(message.body.textContent, "첫 번역 https://example.com");
  assert.equal(message.retry.hidden, false);
  app.toggleTranslation(message);
  assert.equal(message.panel.hidden, true);
  app.toggleTranslation(message);
  assert.equal(message.panel.hidden, false);
  assert.equal(app.requests.length, 1);

  const retry = app.translateState(message, "retry", { force: true });
  assert.equal(app.requests.length, 2);
  assert.equal(message.button.disabled, true);
  assert.equal(message.retry.hidden, true);
  await app.translateState(message, "double-click", { force: true });
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].payload.text, "Hello __DTX_0__");
  app.pending.shift()(success("새 번역 __DTX_0__"));
  await retry;
  assert.equal(message.body.textContent, "새 번역 https://example.com");
  assert.equal(message.button.disabled, false);
  const remounted = state();
  await app.translateState(remounted);
  assert.equal(remounted.body.textContent, "새 번역 https://example.com");
  assert.equal(app.requests.length, 2);
});

test("재시도 실패 후에도 이전 캐시 대신 다시 요청하여 복구한다", async () => {
  const app = harness();
  const message = state();
  const initial = app.translateState(message);
  app.pending.shift()(success("첫 번역"));
  await initial;
  const retry = app.translateState(message, "retry", { force: true });
  app.pending.shift()({ ok: false, error: { code: "RATE_LIMITED", message: "잠시 후 다시 시도" } });
  await retry;
  assert.equal(message.status, "error");
  assert.equal(message.action.dataset.action, "retry");
  assert.equal(message.action.disabled, false);
  const recovery = app.translateState(message);
  assert.equal(app.requests.length, 3);
  app.pending.shift()(success("복구된 번역"));
  await recovery;
  assert.equal(message.body.textContent, "복구된 번역");
});

test("재시도 도중 메시지 DOM이 교체되면 새 UI에 결과를 표시한다", async () => {
  const app = harness();
  const message = state();
  const request = app.translateState(message, "retry", { force: true });
  const remounted = { ...state(), cacheKey: message.cacheKey, sourceHash: message.sourceHash, status: "loading" };
  message.host.isConnected = false;
  app.registerActiveState(remounted);
  app.pending.shift()(success("새 UI의 번역"));
  await request;
  assert.equal(remounted.body.textContent, "새 UI의 번역");
  assert.equal(remounted.retry.hidden, false);
});

test("이전 요청이 늦게 도착해도 더 최신 번역과 캐시를 덮어쓰지 않는다", async () => {
  const app = harness();
  const original = state();
  const oldRequest = app.translateState(original, "old", { force: true });
  const newer = state();
  const newRequest = app.translateState(newer, "new", { force: true });
  app.pending[1](success("최신 번역"));
  await newRequest;
  app.pending[0](success("오래된 번역"));
  await oldRequest;
  assert.equal(newer.body.textContent, "최신 번역");
  const cached = state();
  await app.translateState(cached);
  assert.equal(cached.body.textContent, "최신 번역");
  assert.equal(app.requests.length, 2);
});

test("요청 중 원문이 수정되면 기존 원문의 결과를 표시하지 않는다", async () => {
  const app = harness();
  const message = state();
  const request = app.translateState(message, "retry", { force: true });
  message.content = messageContent("Edited text");
  app.pending.shift()(success("원래 메시지의 번역"));
  await request;
  assert.notEqual(message.body.textContent, "원래 메시지의 번역");
});

const closedChannelError = () => new Error(
  "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"
);

test("번역 중 확장 재로드로 연결이 끊기면 Discord 새로고침으로 복구하도록 안내한다", async () => {
  const app = harness();
  const message = state();
  const request = app.translateState(message);
  app.runtime.id = undefined;
  app.failures[0](closedChannelError());
  await request;
  assert.match(message.body.textContent, /EXTENSION_RELOADED/);
  assert.equal(message.action.dataset.action, "reload");
  assert.equal(message.action.textContent, "Discord 새로고침");
  assert.equal(message.button.disabled, true);
  assert.equal(message.action.disabled, false);
  assert.equal(app.isObserverDisconnected(), true);
  assert.equal(app.errors.length, 0);

  const otherMessage = state();
  await app.translateState(otherMessage);
  await app.openSettings(otherMessage, "settings-after-reload");
  assert.equal(otherMessage.action.dataset.action, "reload");
  assert.equal(app.requests.length, 1, "무효화된 확장으로 추가 요청을 보내지 않는다");
});

test("백그라운드만 중단되고 확장 연결은 유효하면 사용자 재시도로 복구한다", async () => {
  const app = harness();
  const message = state();
  const request = app.translateState(message);
  app.failures[0](closedChannelError());
  await request;
  assert.match(message.body.textContent, /BACKGROUND_DISCONNECTED/);
  assert.equal(message.action.dataset.action, "retry");
  assert.equal(message.button.disabled, false);
  assert.equal(app.isObserverDisconnected(), false);
  assert.equal(app.errors.length, 0);
  const retry = app.translateState(message);
  app.pending[1](success("다시 연결된 번역"));
  await retry;
  assert.equal(message.body.textContent, "다시 연결된 번역");
});

test("설정 열기 도중 확장이 재로드되어도 무효화된 연결로 반복 요청하지 않는다", async () => {
  const app = harness();
  const message = state();
  const opening = app.openSettings(message, "open-settings");
  app.runtime.id = undefined;
  app.failures[0](new Error("Extension context invalidated."));
  await opening;
  assert.equal(message.action.dataset.action, "reload");
  assert.equal(message.action.textContent, "Discord 새로고침");
  assert.equal(message.action.disabled, false);
  assert.equal(app.errors.length, 0);
});

test("연결 종료 알림 직후 확장이 무효화되는 경우에도 새로고침 안내로 전환한다", async () => {
  const app = harness();
  const message = state();
  const request = app.translateState(message);
  app.failures[0](closedChannelError());
  await request;
  app.runtime.id = undefined;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(message.action.dataset.action, "reload");
  assert.equal(app.errors.length, 0);
  assert.equal(app.isObserverDisconnected(), true);
});

test("런타임 속성 접근 자체가 실패해도 Discord 새로고침 안내를 표시한다", async () => {
  const app = harness();
  Object.defineProperty(app.runtime, "id", { get() { throw new Error("Extension context invalidated."); } });
  const message = state();
  await app.translateState(message);
  assert.equal(message.action.dataset.action, "reload");
  assert.equal(app.requests.length, 0);
  assert.equal(app.errors.length, 0);
});

test("예상하지 못한 런타임 오류는 진단 로그를 유지한다", async () => {
  const app = harness();
  const message = state();
  const request = app.translateState(message);
  app.failures[0](new Error("Unexpected serialization failure"));
  await request;
  assert.match(message.body.textContent, /EXTENSION_ERROR/);
  assert.equal(app.errors.length, 1);
  assert.equal(app.isObserverDisconnected(), false);
});
