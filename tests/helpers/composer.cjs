const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "../..");
const fixture = fs.readFileSync(path.join(root, "tests/fixtures/composer.html"), "utf8");
const suggestions = [
  { tone: "natural", en: "Thanks for the update. I'll check it and get back to you.", ko: "업데이트 고마워요. 확인하고 다시 알려드릴게요." },
  { tone: "friendly", en: "Thanks for fixing it! I'll take a look and let you know.", ko: "고쳐 줘서 고마워요! 살펴보고 알려드릴게요." },
  { tone: "polite", en: "Thank you for resolving this. I'll review it and follow up.", ko: "해결해 주셔서 감사합니다. 검토한 뒤 다시 말씀드리겠습니다." }
];

function createHarness({ scripts = true } = {}) {
  const dom = new JSDOM(fixture, { url: "https://discord.com/channels/1/100/threads/200", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const requests = [];
  const changes = [];
  const copied = [];
  window.console.warn = () => {};
  window.chrome = {
    runtime: { id: "test-extension", sendMessage(message) {
      return new Promise((resolve, reject) => requests.push({ message, resolve, reject }));
    } },
    storage: { onChanged: { addListener(listener) { changes.push(listener); }, removeListener() {} } }
  };
  Object.defineProperty(window.navigator, "clipboard", { value: { async writeText(text) { copied.push(text); } } });
  if (scripts) {
    for (const file of ["shared.js", "composer-dom.js", "composer-ui.js", "composer.js"]) {
      window.eval(fs.readFileSync(path.join(root, file), "utf8"));
    }
  }
  const scope = (kind) => window.document.querySelector(kind === "thread" ? "section.chatContent_fixture" : "main.chatContent_fixture");
  const editor = (kind) => scope(kind).querySelector('[role="textbox"]');
  function open(kind = "channel") {
    const host = scope(kind).querySelector('[data-discord-translator-ui="composer-button"]');
    host.shadowRoot.querySelector("button").click();
    return Array.from(window.document.querySelectorAll('[data-discord-translator-ui="composer-popover"]'))
      .find((node) => node.style.display !== "none")?.shadowRoot;
  }
  function intent(ui, value = "해결해 줘서 고맙고, 확인한 뒤 결과를 알려주겠다고 해줘.") {
    ui.querySelector("textarea").value = value;
    ui.querySelector("textarea").dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  function select(ui, id, checked = true) {
    const input = Array.from(ui.querySelectorAll("input[type=checkbox]")).find((node) => node.dataset.contextId.endsWith(`message-content-${id}`));
    if (!input) throw new Error(`Missing context checkbox ${id}`);
    input.checked = checked;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  function reply(kind, messageId) {
    const pane = scope(kind);
    pane.querySelectorAll(".replying_fixture").forEach((node) => node.classList.remove("replying_fixture"));
    let bar = pane.querySelector(".replyBar_fixture");
    if (messageId == null) {
      bar?.remove();
      editor(kind).removeAttribute("aria-describedby");
    } else {
      const message = Array.from(pane.querySelectorAll('[role="article"]')).find((node) => node.querySelector(`[id="message-content-${messageId}"]`));
      message.classList.add("replying_fixture");
      if (!bar) {
        bar = window.document.createElement("div");
        bar.className = "replyBar_fixture";
        pane.querySelector(".channelTextArea_fixture").prepend(bar);
      }
      bar.textContent = "Alex 님에게 답장하는 중";
      editor(kind).setAttribute("aria-describedby", "channel-reply-bar-a11y-description");
    }
    window.DiscordTranslatorComposer?.scan();
  }
  return { window, document: window.document, requests, changes, copied, scope, editor, open, intent, select, reply,
    tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
    close() { window.DiscordTranslatorComposer?.dispose(); window.close(); } };
}

module.exports = { createHarness, suggestions };
