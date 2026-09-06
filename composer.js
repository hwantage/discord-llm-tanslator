(function initializeComposer(root) {
  "use strict";
  if (root.DiscordTranslatorComposer) return;
  const Shared = root.DiscordTranslatorShared;
  const Dom = root.DiscordTranslatorComposerDom;
  const Ui = root.DiscordTranslatorComposerUi;
  const extensionApi = root.browser ?? root.chrome;
  if (!Shared || !Dom || !Ui || !extensionApi?.runtime) return;
  const states = new Map();
  const UI_ATTRIBUTE = "data-discord-translator-ui";
  let active = null;
  let scanTimer = 0;
  let sequence = 0;
  let disposed = false;
  let runtimeInvalid = false;

  function invalidate(state, message = "") {
    const hadResult = state.loading || state.suggestions.length > 0;
    state.version += 1;
    state.loading = false;
    state.suggestions = [];
    state.ui?.setLoading(false);
    state.ui?.renderSuggestions([]);
    if (hadResult) state.ui?.setStatus(message);
  }

  function contextMessages(state) {
    if (state.reply.active) return state.reply.message ? [state.reply.message] : [];
    return state.descriptor.isThread ? Dom.sortMessages(Array.from(state.selected.values())) : [];
  }

  function modeFor(state) {
    return state.reply.active ? "reply" : state.descriptor.isThread && state.selected.size ? "thread" : "new";
  }

  function refreshContext(state, force = false) {
    state.reply = Dom.readReply(state.descriptor, state.reply);
    const messages = Dom.readMessages(state.descriptor);
    for (const message of messages) {
      if (state.selected.has(message.id)) state.selected.set(message.id, message);
    }
    const available = new Map(messages.map((message) => [message.id, message]));
    // Selected snapshots survive virtual scrolling. Unselected conversations
    // populate the chooser only and are never sent to the model.
    for (const [id, message] of state.selected) if (!available.has(id)) available.set(id, message);
    state.messages = Dom.sortMessages(Array.from(available.values()));
    const signature = JSON.stringify({ mode: modeFor(state), reply: state.reply.active,
      context: contextMessages(state).map(({ id, author, text }) => ({ id, author, text })) });
    if (state.contextSignature && state.contextSignature !== signature) {
      invalidate(state, "문맥이 바뀌었습니다. 확인한 뒤 다시 추천해 주세요.");
    }
    state.contextSignature = signature;
    const displaySignature = JSON.stringify([signature, state.reply.message, state.descriptor.isThread, state.selecting, state.messages, Array.from(state.selected.keys())]);
    if (state.ui && (force || displaySignature !== state.displaySignature)) {
      state.ui.renderContext({ ...state.descriptor, reply: state.reply, messages: state.messages, selected: state.selected, selecting: state.selecting });
      state.displaySignature = displaySignature;
      positionPopover();
    }
  }

  function errorStatus(state, error) {
    const message = error?.message || "추천 요청을 처리하지 못했습니다. 다시 시도해 주세요.";
    const invalid = runtimeInvalid || /extension context invalidated|extension has been|context.*invalid/i.test(message);
    if (invalid) {
      runtimeInvalid = true;
      state.ui.setStatus("확장이 다시 로드되었습니다. Discord를 새로고침하면 영어 작성을 계속할 수 있습니다.", "error", {
        label: "Discord 새로고침", run: () => root.location.reload()
      });
    } else {
      const settingsError = ["PROVIDER_PERMISSION_MISSING", "API_AUTH_ERROR", "API_UNREACHABLE", "MODEL_NOT_FOUND", "CONFIG_REQUIRED"].includes(error?.code);
      state.ui.setStatus(message, "error", settingsError ? { label: "연결 설정 열기", run: async () => {
        try {
          const response = await extensionApi.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
          if (!response?.ok) throw response?.error || new Error("설정 페이지를 열지 못했습니다.");
        } catch (failure) { errorStatus(state, failure); }
      } } : null);
    }
  }

  function isAttached(state) {
    return !disposed && active === state && state.descriptor.editor.isConnected &&
      state.routeAtOpen === root.location.pathname &&
      Dom.describeEditor(state.descriptor.editor, root.location.pathname)?.key === state.descriptor.key;
  }

  async function generate(state) {
    if (!isAttached(state) || state.loading || state.inserting) return;
    if (runtimeInvalid) { errorStatus(state, new Error("extension context invalidated")); return; }
    refreshContext(state);
    let payload;
    try {
      payload = Dom.buildRequest(modeFor(state), state.intent, contextMessages(state));
    } catch (error) { errorStatus(state, error); return; }
    invalidate(state);
    const version = state.version;
    state.loading = true;
    state.ui.setLoading(true);
    state.ui.setStatus("추천 문장을 만들고 있습니다.");
    const requestId = `compose-${Date.now().toString(36)}-${++sequence}`;
    try {
      const response = await extensionApi.runtime.sendMessage({ type: "SUGGEST_REPLIES", requestId, payload });
      if (!isAttached(state)) return;
      refreshContext(state);
      if (state.version !== version) return;
      if (!response?.ok) throw response?.error || new Error("확장 백그라운드가 응답하지 않았습니다. 다시 시도해 주세요.");
      state.suggestions = Shared.validateReplySuggestions(response.result?.suggestions);
      state.ui.renderSuggestions(state.suggestions);
      state.ui.setStatus("영어와 한국어 의미를 비교한 뒤 문장을 골라 주세요.");
      positionPopover();
    } catch (error) {
      if (isAttached(state) && state.version === version) {
        errorStatus(state, error);
        console.warn("[DiscordTranslator] composer.request.failed", { requestId, code: error?.code || "RUNTIME_ERROR" });
      }
    } finally {
      if (state.version === version) { state.loading = false; state.ui.setLoading(false); }
    }
  }

  async function insert(state, text) {
    if (!isAttached(state) || state.loading || state.inserting) return;
    refreshContext(state);
    if (!state.suggestions.some((suggestion) => suggestion.en === text)) return;
    const version = state.version;
    state.inserting = true;
    state.ui.setInserting(true);
    try {
      await Dom.insertSuggestion(state.descriptor.editor, text, state.bookmark, () => {
        if (!isAttached(state)) return false;
        refreshContext(state);
        return state.version === version;
      });
      if (active === state) close(false);
    } catch (error) { errorStatus(state, error); }
    finally { state.inserting = false; state.ui.setInserting(false); }
  }

  function createUi(state) {
    const ui = Ui.createPopover({
      onClose: () => close(),
      onIntent: (value) => { state.intent = value; invalidate(state, "내용이 바뀌었습니다. 다시 추천해 주세요."); },
      onGenerate: () => generate(state),
      onSelect: (id, checked) => {
        const message = state.messages.find((entry) => entry.id === id);
        if (checked && !state.selected.has(id) && state.selected.size >= Shared.COMPOSER_LIMITS.messages) {
          ui.setStatus(`참고할 대화는 ${Shared.COMPOSER_LIMITS.messages}개까지 선택할 수 있습니다.`, "error");
        } else if (checked && message) state.selected.set(id, message);
        else state.selected.delete(id);
        refreshContext(state, true);
      },
      onToggleSelection: () => { state.selecting = !state.selecting; refreshContext(state, true); },
      onClearSelection: () => { state.selected.clear(); state.selecting = false; refreshContext(state, true); },
      onInsert: (text) => insert(state, text),
      onCopy: async (text) => {
        try { await root.navigator.clipboard.writeText(text); ui.setStatus("영어 문장을 복사했습니다.", "success"); }
        catch { ui.setStatus("복사할 수 없습니다. 영어 문장을 선택해 직접 복사해 주세요.", "error"); }
      }
    });
    document.body.append(ui.host);
    resizeObserver?.observe(ui.panel);
    return ui;
  }

  function open(state) {
    if (active === state) { close(); return; }
    close(false);
    state.routeAtOpen = root.location.pathname;
    state.bookmark = Dom.captureInsertion(state.descriptor.editor);
    active = state;
    if (!state.ui) state.ui = createUi(state);
    state.ui.setIntent(state.intent);
    refreshContext(state, true);
    state.ui.renderSuggestions(state.suggestions);
    state.ui.show();
    state.button.button.setAttribute("aria-expanded", "true");
    positionPopover();
    state.ui.focus();
    if (runtimeInvalid) errorStatus(state, new Error("extension context invalidated"));
  }

  function close(restoreFocus = true) {
    if (!active) return;
    const state = active;
    active = null;
    if (state.loading) invalidate(state);
    state.ui.hide();
    state.button.button.setAttribute("aria-expanded", "false");
    if (restoreFocus && state.button.host.isConnected) state.button.button.focus();
  }

  function positionPopover() {
    if (!active?.ui || active.ui.host.style.display === "none") return;
    const ui = active.ui;
    const rect = active.descriptor.area.getBoundingClientRect();
    const maxHeight = Math.max(160, Math.min(760, root.innerHeight - 24, rect.top > 280 ? rect.top - 22 : root.innerHeight - 24));
    ui.panel.style.maxHeight = `${maxHeight}px`;
    const panelRect = ui.panel.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.right - panelRect.width, root.innerWidth - panelRect.width - 12));
    const top = Math.max(12, Math.min(rect.top - panelRect.height - 10, root.innerHeight - panelRect.height - 12));
    ui.host.style.left = `${left}px`;
    ui.host.style.top = `${top}px`;
  }

  function createState(descriptor) {
    const state = { descriptor, intent: "", version: 0, loading: false, inserting: false, suggestions: [],
      selected: new Map(), messages: [], reply: null, selecting: descriptor.isThread, contextSignature: "", displaySignature: "", ui: null };
    state.button = Ui.createButton();
    state.button.button.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
    state.button.button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(state); });
    states.set(descriptor.key, state);
    return state;
  }

  function scan() {
    if (disposed) return;
    scanTimer = 0;
    if (active && active.routeAtOpen !== root.location.pathname) close(false);
    const seen = new Set();
    for (const editor of document.querySelectorAll(Dom.EDITOR_SELECTOR)) {
      const descriptor = Dom.describeEditor(editor, root.location.pathname);
      if (!descriptor || editor.closest('[hidden], [aria-hidden="true"]') || seen.has(descriptor.key)) continue;
      seen.add(descriptor.key);
      let state = states.get(descriptor.key);
      if (!state) state = createState(descriptor);
      if (state.descriptor.editor !== editor) {
        if (active === state) close(false);
        invalidate(state);
        state.reply = null;
      }
      state.descriptor = descriptor;
      if (state.button.host.parentElement !== descriptor.anchor) descriptor.anchor.prepend(state.button.host);
      if (active === state) refreshContext(state);
    }
    for (const [key, state] of states) {
      if (!seen.has(key)) {
        if (active === state) close(false);
        state.button.host.remove();
        if (state.loading) invalidate(state);
        // Keep a bounded number of per-channel drafts in tab memory only.
        if (states.size > 20) {
          if (state.ui) { resizeObserver?.unobserve(state.ui.panel); state.ui.host.remove(); }
          states.delete(key);
        }
      }
    }
  }

  function scheduleScan() {
    if (!disposed && !scanTimer) scanTimer = root.setTimeout(scan, 80);
  }

  function ownMutation(mutation) {
    const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
    if (target?.closest(`[${UI_ATTRIBUTE}]`)) return true;
    const changed = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
    return mutation.type === "childList" && changed.length > 0 && changed.every((node) => node.nodeType === 1 && node.hasAttribute(UI_ATTRIBUTE));
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !ownMutation(mutation))) scheduleScan();
  });
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(positionPopover) : null;
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["class", "aria-label", "aria-describedby", "contenteditable"] });

  function onPageClick(event) {
    const path = event.composedPath();
    if (path.some((node) => node?.hasAttribute?.(UI_ATTRIBUTE))) return;
    // A new reply to the same author can retain the same reply-bar DOM. Discard
    // the old target snapshot before Discord changes that local state.
    const control = event.target.closest?.('[role="button"], [role="menuitem"]');
    if (control && (/^(reply|답장)$/i.test(control.getAttribute("aria-label") || "") || control.id === "message-reply")) {
      for (const state of states.values()) state.reply = null;
      if (active) invalidate(active, "답장 대상이 바뀌었습니다. 원글을 확인해 주세요.");
      scheduleScan();
    }
  }
  function onPointerDown(event) {
    if (!active || event.composedPath().some((node) => node === active.ui.host || node === active.button.host)) return;
    close(false);
  }
  function onSettingsChanged(changes, area) {
    if (area === "local" && changes.providerSettings) {
      for (const state of states.values()) invalidate(state, "연결 설정이 바뀌었습니다. 다시 추천해 주세요.");
    }
  }
  document.addEventListener("click", onPageClick, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("resize", positionPopover);
  root.addEventListener("scroll", positionPopover, true);
  root.addEventListener("popstate", scheduleScan);
  extensionApi.storage?.onChanged?.addListener(onSettingsChanged);
  root.DiscordTranslatorComposer = Object.freeze({ scan, close, dispose() {
    close(false);
    disposed = true;
    root.clearTimeout(scanTimer);
    observer.disconnect();
    resizeObserver?.disconnect();
    document.removeEventListener("click", onPageClick, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("resize", positionPopover);
    root.removeEventListener("scroll", positionPopover, true);
    root.removeEventListener("popstate", scheduleScan);
    extensionApi.storage?.onChanged?.removeListener?.(onSettingsChanged);
    for (const state of states.values()) { state.button.host.remove(); state.ui?.host.remove(); }
    states.clear();
  } });
  scan();
})(globalThis);
