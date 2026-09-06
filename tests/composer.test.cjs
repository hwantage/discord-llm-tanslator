const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness, suggestions } = require("./helpers/composer.cjs");

function harness(t) { const h = createHarness(); t.after(() => h.close()); return h; }
const result = () => ({ ok: true, result: { suggestions, model: "test-model" } });
const clickGenerate = (ui) => ui.querySelector(".generate").click();
const bodyOf = (h, index = 0) => JSON.parse(JSON.stringify(h.requests[index].message.payload));

test("신규 글은 원글 영역 없이 의도만 보내고 영어·한국어 후보 3개를 보여준다", async (t) => {
  const h = harness(t);
  assert.equal(h.document.querySelectorAll('[data-discord-translator-ui="composer-button"]').length, 2);
  const ui = h.open();
  assert.equal(ui.querySelector(".context").hidden, true);
  assert.equal(h.requests.length, 0);
  h.intent(ui, "새 프로젝트를 소개하고 싶어");
  clickGenerate(ui);
  clickGenerate(ui);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(bodyOf(h), { mode: "new", intent: "새 프로젝트를 소개하고 싶어", context: [] });
  h.requests[0].resolve(result());
  await h.tick();
  assert.equal(ui.querySelectorAll(".result").length, 3);
  assert.equal(ui.querySelector(".english").textContent, suggestions[0].en);
  assert.equal(ui.querySelector(".korean").textContent, suggestions[0].ko);
  ui.querySelector(".copy").click();
  await h.tick();
  assert.deepEqual(h.copied, [suggestions[0].en]);
});

test("이미 진입한 스레드에서는 선택한 대화만 시간순으로 전달한다", (t) => {
  const h = harness(t);
  const ui = h.open("thread");
  assert.equal(ui.querySelectorAll("input[type=checkbox]").length, 3);
  h.select(ui, 202);
  h.select(ui, 200);
  h.intent(ui);
  clickGenerate(ui);
  const payload = bodyOf(h);
  assert.equal(payload.mode, "thread");
  assert.equal(payload.context.length, 2);
  assert.match(payload.context[0].text, /release notes seem/);
  assert.match(payload.context[1].text, /anything else/);
  assert.equal(JSON.stringify(payload).includes("clearing the cache"), false);
});

test("스레드 안의 직접 답장은 선택 문맥을 섞지 않고 대상 원글 한 개만 사용한다", (t) => {
  const h = harness(t);
  const ui = h.open("thread");
  h.select(ui, 200);
  h.select(ui, 202);
  h.reply("thread", 201);
  assert.equal(ui.querySelectorAll("input[type=checkbox]").length, 0);
  assert.match(ui.querySelector(".context").textContent, /fixed the workflow/);
  h.intent(ui);
  clickGenerate(ui);
  const payload = bodyOf(h);
  assert.equal(payload.mode, "reply");
  assert.equal(payload.context.length, 1);
  assert.match(payload.context[0].text, /fixed the workflow/);
  h.reply("thread", null);
  assert.equal(ui.querySelectorAll("input:checked").length, 2);
});

test("일반 Direct 답장에서도 원글을 자동 표시하고 요청에 포함한다", (t) => {
  const h = harness(t);
  h.reply("channel", 1000);
  const ui = h.open();
  assert.match(ui.querySelector(".context").textContent, /clearing the cache/);
  h.intent(ui);
  clickGenerate(ui);
  assert.equal(bodyOf(h).mode, "reply");
  assert.equal(bodyOf(h).context.length, 1);
});

test("원글을 확인하지 못한 Direct 답장은 신규 작성으로 오인하지 않는다", (t) => {
  const h = harness(t);
  h.reply("thread", 201);
  h.scope("thread").querySelector(".replying_fixture").remove();
  const ui = h.open("thread");
  h.intent(ui);
  assert.match(ui.querySelector(".context").textContent, /원글을 아직 확인/);
  assert.equal(ui.querySelector(".generate").disabled, true);
  clickGenerate(ui);
  assert.equal(h.requests.length, 0);
});

test("의도 수정 및 더 최신 요청 이후 늦게 도착한 응답은 무시한다", async (t) => {
  const h = harness(t);
  const ui = h.open();
  h.intent(ui, "첫 번째 의도"); clickGenerate(ui);
  h.intent(ui, "두 번째 의도"); clickGenerate(ui);
  h.requests[1].resolve(result()); await h.tick();
  h.requests[0].resolve({ ok: false, error: { message: "old error" } }); await h.tick();
  assert.equal(ui.querySelectorAll(".result").length, 3);
  assert.equal(ui.querySelector(".status").textContent.includes("old error"), false);
  assert.equal(ui.querySelector("textarea").value, "두 번째 의도");
});

test("같은 작성자의 다른 글로 답장 대상이 바뀌어도 이전 응답을 폐기한다", async (t) => {
  const h = harness(t);
  h.reply("thread", 201);
  const ui = h.open("thread");
  h.intent(ui); clickGenerate(ui);
  h.reply("thread", 202);
  h.requests[0].resolve(result()); await h.tick();
  assert.equal(ui.querySelectorAll(".result").length, 0);
  assert.match(ui.querySelector(".context").textContent, /anything else/);
});

test("선택 문맥을 수정하면 이전 추천이 무효화되고 문맥 없이 새 글을 쓸 수도 있다", async (t) => {
  const h = harness(t);
  const ui = h.open("thread");
  h.select(ui, 201); h.intent(ui); clickGenerate(ui);
  h.requests[0].resolve(result()); await h.tick();
  h.document.getElementById("message-content-201").textContent = "The fix is still in progress.";
  h.window.DiscordTranslatorComposer.scan();
  assert.equal(ui.querySelectorAll(".result").length, 0);
  ui.querySelector('[data-action="clear"]').click(); clickGenerate(ui);
  assert.equal(bodyOf(h, 1).mode, "new");
  assert.deepEqual(bodyOf(h, 1).context, []);
});

test("원글의 한국어 번역 표시가 갱신되어도 같은 원문에 대한 작성 추천은 유지한다", async (t) => {
  const h = harness(t);
  h.reply("thread", 201);
  const ui = h.open("thread");
  h.intent(ui); clickGenerate(ui);
  const translation = h.document.createElement("div");
  translation.setAttribute("data-discord-translator-ui", "translation");
  translation.setAttribute("data-state", "success");
  const body = h.document.createElement("div");
  body.className = "body";
  body.textContent = "워크플로를 수정했어요. 업데이트된 릴리스 노트를 확인할 수 있습니다.";
  translation.attachShadow({ mode: "open" }).append(body);
  h.document.getElementById("message-content-201").parentElement.append(translation);
  h.window.DiscordTranslatorComposer.scan();
  h.requests[0].resolve(result()); await h.tick();
  assert.equal(ui.querySelectorAll(".result").length, 3);
  assert.equal(ui.querySelector(".context-ko").textContent, body.textContent);
  assert.equal(h.requests.length, 1);
});

test("실패해도 한국어 초안과 선택 문맥을 유지하며 다시 요청할 수 있다", async (t) => {
  const h = harness(t);
  const ui = h.open("thread");
  h.select(ui, 201); h.intent(ui, "고쳐 줘서 고마워"); clickGenerate(ui);
  h.requests[0].resolve({ ok: false, error: { code: "TIMEOUT", message: "응답 시간이 초과되었습니다." } }); await h.tick();
  assert.equal(ui.querySelector("textarea").value, "고쳐 줘서 고마워");
  assert.equal(ui.querySelectorAll("input:checked").length, 1);
  assert.equal(ui.querySelector(".status").dataset.kind, "error");
  clickGenerate(ui);
  assert.equal(h.requests.length, 2);
});

test("닫았다 열어도 초안을 유지하며 입력창 재생성 때 중복 버튼과 오래된 결과가 남지 않는다", async (t) => {
  const h = harness(t);
  let ui = h.open("thread");
  h.intent(ui, "내 초안"); clickGenerate(ui);
  const old = h.editor("thread"); old.replaceWith(old.cloneNode(true));
  h.window.DiscordTranslatorComposer.scan();
  assert.equal(h.document.querySelectorAll('[data-discord-translator-ui="composer-button"]').length, 2);
  h.requests[0].resolve(result()); await h.tick();
  ui = h.open("thread");
  assert.equal(ui.querySelector("textarea").value, "내 초안");
  assert.equal(ui.querySelectorAll(".result").length, 0);
});

test("채널 이동이나 연결 설정 변경 이후의 오래된 추천을 적용하지 않는다", async (t) => {
  const h = harness(t);
  const ui = h.open(); h.intent(ui); clickGenerate(ui);
  h.changes[0]({ providerSettings: {} }, "local");
  h.requests[0].resolve(result()); await h.tick();
  assert.equal(ui.querySelectorAll(".result").length, 0);
  clickGenerate(ui);
  h.window.history.pushState({}, "", "/channels/1/999"); h.window.DiscordTranslatorComposer.scan();
  h.requests[1].resolve(result()); await h.tick();
  assert.equal(ui.host.style.display, "none");
  assert.equal(ui.querySelectorAll(".result").length, 0);
});

test("한글 조합 중 Enter는 요청하지 않고 일반 Enter가 Discord 전송으로 전파되지 않는다", (t) => {
  const h = harness(t);
  const ui = h.open(); h.intent(ui);
  const textarea = ui.querySelector("textarea");
  let forwarded = 0;
  h.document.addEventListener("keydown", () => { forwarded += 1; });
  textarea.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true, bubbles: true, composed: true }));
  textarea.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
  assert.equal(h.requests.length, 0);
  assert.equal(forwarded, 0);
  textarea.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, composed: true }));
  assert.equal(h.requests.length, 1);
});

test("추천과 원글의 HTML 모양 텍스트는 실행하지 않고 글자로 표시한다", async (t) => {
  const h = harness(t);
  h.document.getElementById("message-content-201").textContent = '<img src=x onerror="alert(1)">';
  h.reply("thread", 201);
  const ui = h.open("thread"); h.intent(ui); clickGenerate(ui);
  h.requests[0].resolve({ ok: true, result: { suggestions: suggestions.map((s, i) => i ? s : { ...s, en: '<img src=x onerror="alert(1)">' }) } });
  await h.tick();
  assert.equal(ui.querySelectorAll("img").length, 0);
  assert.match(ui.querySelector(".english").textContent, /<img/);
});
