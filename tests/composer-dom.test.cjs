const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./helpers/composer.cjs");

function harness(t) {
  const h = createHarness();
  t.after(() => h.close());
  h.api = h.window.DiscordTranslatorComposerDom;
  h.describe = (kind) => h.api.describeEditor(h.editor(kind), h.window.location.pathname);
  return h;
}

test("실제 Discord 형태의 채널과 스레드 입력창을 각각 연결하고 검색창·메시지 수정창은 제외한다", (t) => {
  const h = harness(t);
  assert.equal(h.describe("channel").key, "channel:100");
  assert.equal(h.describe("channel").isThread, false);
  assert.equal(h.describe("thread").key, "thread:200");
  assert.equal(h.describe("thread").isThread, true);
  assert.equal(h.api.describeEditor(h.document.querySelector('[role="combobox"]'), h.window.location.pathname), null);
  const channelEditor = h.editor("channel");
  const editing = channelEditor.cloneNode(true);
  h.scope("channel").querySelector('[role="article"]').append(editing);
  assert.equal(h.api.describeEditor(editing, h.window.location.pathname), null);
  assert.equal(h.api.describeEditor(channelEditor, h.window.location.pathname).key, "channel:100");
});

test("단독 화면으로 열린 스레드와 아직 본문이 로드되지 않은 스레드도 인식한다", (t) => {
  const h = harness(t);
  h.scope("thread").closest('[class*="chatLayerWrapper_"]').removeAttribute("class");
  assert.equal(h.describe("thread").key, "thread:200");
  h.window.history.pushState({}, "", "/channels/1/200");
  assert.equal(h.describe("thread").key, "thread:200");
  assert.equal(h.describe("channel"), null);
  h.scope("thread").querySelectorAll("li").forEach((message) => message.remove());
  h.window.history.pushState({}, "", "/channels/1/100/threads/200");
  assert.equal(h.describe("thread").key, "thread:200");
});

test("스레드 문맥에는 해당 스레드의 본문만 포함하며 중복 li, 인용 미리보기, 번역 UI를 제외한다", (t) => {
  const h = harness(t);
  const extra = h.document.createElement("span");
  extra.setAttribute("data-discord-translator-ui", "button");
  extra.textContent = "한국어로 번역";
  h.document.getElementById("message-content-201").append(extra);
  const messages = h.api.readMessages(h.describe("thread"));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].id, "200:message-content-200");
  assert.equal(messages[2].author, "Alex");
  assert.equal(messages.some((m) => /clearing the cache|한국어로 번역/.test(m.text)), false);
  const channel = h.api.readMessages(h.describe("channel"));
  assert.equal(channel.length, 2);
  assert.equal(channel[1].text, "That helped. Thank you!");
  assert.equal(channel[1].author, "Sam");
});

test("채널과 스레드의 직접 답장을 각자의 replying 메시지로 식별한다", (t) => {
  const h = harness(t);
  h.reply("channel", 1000);
  h.reply("thread", 201);
  const channel = h.api.readReply(h.describe("channel"));
  const thread = h.api.readReply(h.describe("thread"));
  assert.match(channel.message.text, /clearing the cache/);
  assert.match(thread.message.text, /fixed the workflow/);
  assert.equal(thread.message.id, "200:message-content-201");
  h.reply("thread", null);
  assert.equal(h.api.readReply(h.describe("thread")).active, false);
});

test("원글이 가상 스크롤로 사라지면 이미 확인한 같은 답장 원글만 유지한다", (t) => {
  const h = harness(t);
  h.reply("thread", 201);
  const descriptor = h.describe("thread");
  const previous = h.api.readReply(descriptor);
  h.scope("thread").querySelector(".replying_fixture").closest("li").remove();
  assert.equal(h.api.readReply(descriptor, previous).message.id, previous.message.id);
  assert.equal(h.api.readReply(descriptor).message, null);
  previous.bar.replaceWith(previous.bar.cloneNode(true));
  assert.equal(h.api.readReply(descriptor, previous).message, null);
});

test("문맥에서 코드·링크·줄바꿈을 읽을 수 있게 보존한다", (t) => {
  const h = harness(t);
  const body = h.document.getElementById("message-content-201");
  body.innerHTML = 'Run <code>npm test</code><br>Read <a href="https://example.com/docs">the guide</a><pre>if (ok) {\n  run();\n}</pre><img alt="🙂">';
  const message = h.api.readMessages(h.describe("thread")).find((m) => m.id.endsWith("201"));
  assert.match(message.text, /`npm test`\nRead the guide \(https:\/\/example.com\/docs\)/);
  assert.match(message.text, /  run\(\);/);
  assert.match(message.text, /🙂/);
});

test("선택한 글만 시간순으로 정렬하며 작성자 이름과 Discord 식별자를 API 요청에서 제거한다", (t) => {
  const h = harness(t);
  const messages = h.api.readMessages(h.describe("thread"));
  const request = h.api.buildRequest("thread", "고맙다고 하고 확인해 보겠다고 해줘", [messages[2], messages[1]]);
  assert.equal(request.context.length, 2);
  assert.match(request.context[0].text, /fixed the workflow/);
  assert.equal(request.context[0].speaker, request.context[1].speaker);
  assert.equal(/Alex|message-content|channelId|timestamp/.test(JSON.stringify(request)), false);
});

test("채널 전환 직후 남은 이전 입력창은 새 경로에 연결하지 않는다", (t) => {
  const h = harness(t);
  h.window.history.pushState({}, "", "/channels/1/999");
  assert.equal(h.describe("channel"), null);
  assert.equal(h.describe("thread"), null);
});

test("팝오버를 연 뒤 바뀐 기존 초안에는 번역문을 덮어쓰거나 추가하지 않는다", async (t) => {
  const h = harness(t);
  const editor = h.editor("channel");
  const bookmark = h.api.captureInsertion(editor);
  editor.textContent = "My existing draft";
  await assert.rejects(h.api.insertSuggestion(editor, "A suggestion", bookmark), { code: "EDITOR_CHANGED" });
  assert.equal(editor.textContent, "My existing draft");
});

test("선택 범위는 끝으로 접어 기존 선택 텍스트를 보존한다", (t) => {
  const h = harness(t);
  const editor = h.editor("channel");
  editor.textContent = "Keep this draft";
  const range = h.document.createRange();
  range.setStart(editor.firstChild, 0);
  range.setEnd(editor.firstChild, 4);
  h.document.getSelection().addRange(range);
  const saved = h.api.captureInsertion(editor);
  assert.equal(saved.range.collapsed, true);
  assert.equal(saved.range.startOffset, 4);
  assert.equal(editor.textContent, "Keep this draft");
});
