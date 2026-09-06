(function initializeComposerDom(root, factory) {
  const api = factory(root.DiscordTranslatorShared || (typeof require === "function" ? require("./shared.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DiscordTranslatorComposerDom = api;
})(globalThis, function createComposerDom(Shared) {
  "use strict";

  const EDITOR_SELECTOR = '[role="textbox"][data-slate-editor="true"][contenteditable="true"]';
  const MESSAGE_SELECTOR = '[role="article"][data-list-item-id*="chat-messages-"], li[id^="chat-messages-"]';
  const UI_ATTRIBUTE = "data-discord-translator-ui";

  function getMessageElements(scope) {
    return Array.from(scope.querySelectorAll(MESSAGE_SELECTOR)).filter((element) =>
      !element.closest(`[${UI_ATTRIBUTE}]`) &&
      !(element.tagName === "LI" && element.querySelector('[role="article"][data-list-item-id]'))
    );
  }

  function readMessageIds(element) {
    const key = element.getAttribute("data-list-item-id") || element.id || "";
    const match = key.match(/chat-messages-(\d+)-(\d+)$/);
    return match ? { channelId: match[1], messageId: match[2] } : null;
  }

  function describeEditor(editor, pathname) {
    if (!editor.matches(EDITOR_SELECTOR) || editor.closest(MESSAGE_SELECTOR) ||
        editor.closest(`[${UI_ATTRIBUTE}]`) || editor.getAttribute("aria-disabled") === "true") return null;
    const form = editor.closest("form");
    const scope = form?.closest('[class*="chatContent_"]');
    const area = editor.closest('[class*="channelTextArea_"]');
    const composers = scope ? Array.from(scope.querySelectorAll(EDITOR_SELECTOR)).filter((candidate) => !candidate.closest(MESSAGE_SELECTOR)) : [];
    if (!form || !scope || !area || composers.length !== 1) return null;
    const route = pathname.match(/^\/channels\/([^/]+)\/(\d+)(?:\/threads\/(\d+))?/);
    if (!route) return null;
    const label = scope.getAttribute("aria-label") || editor.getAttribute("aria-label") || "";
    const inThreadPane = Boolean(scope.closest('[class*="chatLayerWrapper_"], [class*="threadSidebar_"]'));
    const hasThreadLabel = /\((?:스레드|thread)\)\s*$/i.test(label);
    const messageIds = getMessageElements(scope).map(readMessageIds).find(Boolean);
    const channelId = messageIds?.channelId || ((inThreadPane || hasThreadLabel) && route[3] ? route[3] : route[2]);
    const isThread = inThreadPane || hasThreadLabel || Boolean(route[3] && channelId === route[3]);
    // A route can change before React replaces the old pane. Do not bind that
    // old channel's editor to the newly selected route during the transition.
    const expectedChannel = isThread && route[3] ? route[3] : route[2];
    if (channelId !== expectedChannel) return null;
    const buttons = area.querySelector('[class*="buttons_"]');
    const anchor = buttons || area;
    return { editor, form, scope, area, anchor, channelId, isThread, label, key: `${isThread ? "thread" : "channel"}:${channelId}` };
  }

  function readNode(node) {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.hasAttribute(UI_ATTRIBUTE) || node.matches("script, style, button, [data-slate-placeholder]")) return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "IMG") return node.getAttribute("alt") || "";
    if (node.tagName === "PRE") return `\n\`\`\`\n${node.textContent}\n\`\`\`\n`;
    if (node.tagName === "CODE") return `\`${node.textContent}\``;
    let text = Array.from(node.childNodes).map(readNode).join("");
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (/^https?:\/\//.test(href) && text && text !== href) text = `${text} (${href})`;
    }
    if (["DIV", "P", "LI", "BLOCKQUOTE"].includes(node.tagName)) text = `\n${text}\n`;
    return text;
  }

  function getMessageBody(element) {
    const labelledId = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .find((id) => /^message-content-\d+$/.test(id));
    if (labelledId) {
      const body = element.querySelector(`[id="${labelledId}"]`);
      if (body) return body;
    }
    return Array.from(element.querySelectorAll('[id^="message-content-"]')).find((body) =>
      !body.closest('[id^="message-reply-context-"]') && !body.closest(`[${UI_ATTRIBUTE}]`)
    ) || null;
  }

  function readMessage(element, scope) {
    const ids = readMessageIds(element);
    const body = getMessageBody(element);
    if (!ids || !body || /(?:^|\s)(?:systemMessage|isSystemMessage)_/.test(element.className)) return null;
    const text = readNode(body).replace(/\u00a0/g, " ").replace(/\uFEFF/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return null;
    const usernameId = (element.getAttribute("aria-labelledby") || "").split(/\s+/)
      .find((id) => /^message-username-\d+$/.test(id));
    const username = usernameId ? scope.querySelector(`[id="${usernameId}"]`) : null;
    const contents = body.closest('[class*="contents_"]') || element;
    const author = (username?.querySelector('[class*="username_"]')?.textContent || username?.textContent ||
      contents.querySelector('[class*="username_"]')?.textContent || "참여자").trim();
    const translationHost = element.querySelector(`[${UI_ATTRIBUTE}="translation"][data-state="success"]`);
    const translation = translationHost?.shadowRoot?.querySelector(".body")?.textContent?.trim() || "";
    const timestamp = element.querySelector("time[datetime]")?.getAttribute("datetime") || "";
    return {
      id: `${ids.channelId}:${body.id || ids.messageId}`,
      messageId: ids.messageId,
      author,
      text,
      translation,
      timestamp
    };
  }

  function readMessages(descriptor) {
    const entries = getMessageElements(descriptor.scope).map((node) => readMessage(node, descriptor.scope)).filter(Boolean);
    return Array.from(new Map(entries.map((entry) => [entry.id, entry])).values());
  }

  function readReply(descriptor, previous = null) {
    // The bar carries only the author's name. The actual target is the replying
    // message in this composer's pane, not the preview inside a posted reply.
    const bar = descriptor.form.querySelector('[class*="replyBar_"], [id="channel-reply-bar-a11y-description"]');
    if (!bar) return { active: false, message: null, bar: null, label: "" };
    const label = bar.textContent;
    const targets = getMessageElements(descriptor.scope).filter((node) => /(?:^|\s)replying_/.test(node.className));
    if (targets.length === 1) {
      return { active: true, message: readMessage(targets[0], descriptor.scope), bar, label };
    }
    // Keep a known target while Discord virtualizes it out of the message list.
    // Changing the reply target explicitly clears this cache in composer.js.
    const message = previous?.bar === bar && previous.label === label ? previous.message : null;
    return { active: true, message, bar, label };
  }

  function sortMessages(messages) {
    return [...messages].sort((a, b) => {
      if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
      const left = a.messageId || "";
      const right = b.messageId || "";
      return left.length - right.length || left.localeCompare(right);
    });
  }

  function buildRequest(mode, intent, messages) {
    const speakers = new Map();
    const context = sortMessages(messages).map((message) => {
      if (!speakers.has(message.author)) speakers.set(message.author, `participant_${speakers.size + 1}`);
      return { speaker: speakers.get(message.author), text: message.text };
    });
    return Shared.sanitizeComposeRequest({ mode, intent, context });
  }

  function captureInsertion(editor) {
    const selection = editor.ownerDocument.getSelection();
    let range = null;
    if (selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
      range = selection.getRangeAt(0).cloneRange();
      // Preserve an existing draft, including any selected text.
      range.collapse(false);
    }
    if (!range) {
      range = editor.ownerDocument.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    return { editor, range, html: editor.innerHTML };
  }

  async function insertSuggestion(editor, text, bookmark, isCurrent = () => true) {
    const doc = editor.ownerDocument;
    const win = doc.defaultView;
    const valid = () => editor.isConnected && editor.matches(EDITOR_SELECTOR) && bookmark?.editor === editor &&
      editor.innerHTML === bookmark.html && isCurrent();
    if (!valid() || !editor.contains(bookmark.range.startContainer) || !editor.contains(bookmark.range.endContainer)) {
      throw Shared.createError("EDITOR_CHANGED", "입력창 내용이나 답장 대상이 바뀌었습니다. 작성 창을 다시 열어 삽입 위치를 확인해 주세요.");
    }
    editor.focus();
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(bookmark.range.cloneRange());
    doc.dispatchEvent(new win.Event("selectionchange"));
    // Slate synchronizes DOM selection with its model using a throttled listener.
    await new Promise((resolve) => win.setTimeout(resolve, 150));
    if (!valid() || doc.activeElement !== editor) {
      throw Shared.createError("EDITOR_CHANGED", "입력창이 바뀌었습니다. 다시 열어 삽입 위치를 확인해 주세요.");
    }
    const before = editor.textContent;
    let event;
    try {
      const data = new win.DataTransfer();
      data.setData("text/plain", text);
      event = new win.ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
      editor.dispatchEvent(event);
    } catch {
      throw Shared.createError("INSERT_UNAVAILABLE", "자동 입력을 사용할 수 없습니다. 문장의 복사 버튼으로 붙여넣어 주세요.");
    }
    // Plain-text paste is handled by Slate's own insertData path, retaining its
    // document model and undo history. Never write innerHTML/textContent here.
    // https://github.com/ianstormtaylor/slate/blob/main/packages/slate-react/src/components/editable.tsx
    await new Promise((resolve) => win.setTimeout(resolve, 60));
    if (!event.defaultPrevented || editor.textContent === before) {
      throw Shared.createError("INSERT_UNAVAILABLE", "입력 결과를 확인하지 못했습니다. 입력창을 확인한 뒤 필요하면 복사 버튼으로 붙여넣어 주세요.");
    }
  }

  return Object.freeze({ EDITOR_SELECTOR, MESSAGE_SELECTOR, describeEditor, readMessage, readMessages, readReply,
    sortMessages, buildRequest, captureInsertion, insertSuggestion });
});
