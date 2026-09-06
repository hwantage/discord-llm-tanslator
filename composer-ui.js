(function initializeComposerUi(root) {
  "use strict";
  const Shared = root.DiscordTranslatorShared;
  const UI_ATTRIBUTE = "data-discord-translator-ui";
  const PEN = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function createButton() {
    const host = document.createElement("span");
    host.setAttribute(UI_ATTRIBUTE, "composer-button");
    host.setAttribute("contenteditable", "false");
    host.style.cssText = "display:inline-flex;align-self:center;flex:none;margin:0 4px;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      button{display:flex;align-items:center;gap:5px;background:transparent;color:var(--text-muted,#b5bac1);border:1px solid transparent;border-radius:7px;padding:6px;cursor:pointer;font:600 12px system-ui,sans-serif;white-space:nowrap}
      button:hover,button[aria-expanded=true]{background:rgb(84 226 209 / 12%);color:#77e2cf;border-color:rgb(84 226 209 / 25%)}
      button:focus-visible{outline:2px solid #77e2cf;outline-offset:2px}svg{width:18px;height:18px}
    </style><button type="button" aria-label="영어 작성 도우미 열기" aria-haspopup="dialog" aria-expanded="false" title="한국어로 의도를 쓰고 영어 문장 고르기">${PEN}<span>영어</span></button>`;
    return { host, button: shadow.querySelector("button") };
  }

  function createPopover(handlers) {
    const host = document.createElement("div");
    host.setAttribute(UI_ATTRIBUTE, "composer-popover");
    host.style.cssText = "position:fixed;z-index:2147483000;display:none;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{color-scheme:dark;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e4e7ec;text-align:left}
      *{box-sizing:border-box}[hidden]{display:none!important}button,input,textarea{font:inherit}button{cursor:pointer}
      button:disabled{cursor:default;opacity:.48}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #77e2cf;outline-offset:3px}
      .panel{width:min(470px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:#1d2027;border:1px solid #414550;border-radius:14px;box-shadow:0 16px 55px #0008,0 2px 8px #0005;overscroll-behavior:contain;scrollbar-width:thin}
      .header{display:flex;align-items:center;gap:10px;padding:16px 18px 12px;border-bottom:1px solid #333743}
      .mark{color:#79e3ce;display:flex}.mark svg{width:22px;height:22px}.heading{flex:1;font-weight:700;font-size:15px;letter-spacing:-.3px}
      .mode{font-size:11px;color:#aeb6c4;font-weight:500;margin-left:8px}.close{background:transparent;color:#aeb6c4;border:0;font-size:23px;line-height:1;padding:4px 6px;border-radius:5px}.close:hover{background:#353a44;color:white}
      .content{padding:16px 18px 18px}.context{margin-bottom:16px}.context-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px;font-size:12px;font-weight:650;color:#bac4d1}
      .context-heading .controls{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}.small{font-size:11px;padding:3px 7px;border-radius:5px;background:transparent;border:1px solid #454b58;color:#ccd4df}.small:hover{background:#333a45}
      .context-list{display:grid;gap:8px;max-height:225px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
      .context-card{padding:10px 12px;border-radius:8px;border:1px solid #3b4250;background:#252b34;border-left:3px solid #637489}.context-card.selected,.context-card.original{border-left-color:#79e3ce;background:#23322f}
      .context-top{display:flex;align-items:center;gap:7px;margin:0 0 5px;color:#d3dce6;font-size:12px;font-weight:650}.context-top input{accent-color:#79e3ce;width:15px;height:15px;margin:0}.context-top time{margin-left:auto;color:#929dab;font-size:10px;font-weight:400}.context-top label{display:flex;align-items:center;gap:7px;cursor:pointer}
      .context-text{font-size:12px;line-height:1.55;margin:0;color:#c1cbd7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:5em;overflow:hidden}.context-card.expanded .context-text{max-height:none}.context-ko{font-size:12px;white-space:pre-wrap;color:#8acbb9;margin:7px 0 0;overflow-wrap:anywhere}.expand{color:#a0bbcf;font-size:11px;border:0;background:none;padding:4px 0 0;text-decoration:underline;text-underline-offset:3px}
      .hint{font-size:11px;color:#929dab;margin:8px 0 0;line-height:1.5}.context-error{font-size:12px;color:#f6b9a5;background:#422d29;padding:10px;border-radius:7px}
      .intent-label{display:block;font-size:12px;font-weight:650;margin-bottom:7px;color:#d6dde7}textarea{display:block;width:100%;min-height:102px;max-height:240px;resize:vertical;color:#edf0f5;background:#15181e;border:1px solid #424957;border-radius:8px;padding:11px 12px;line-height:1.6;outline-offset:0!important}textarea:focus{border-color:#79e3ce}textarea::placeholder{color:#788392}
      .input-meta{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#8793a3;margin:6px 0 13px}.generate{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:#85e4ce;color:#102c25;border:1px solid transparent;border-radius:8px;padding:9px 14px;font-weight:750;font-size:13px}.generate:hover:not(:disabled){background:#a7efde}.generate[aria-busy=true]::before{content:"";width:13px;height:13px;border:2px solid #24514355;border-top-color:#245143;border-radius:50%;animation:spin .8s linear infinite}
      .status{font-size:12px;margin-top:10px;color:#a9b6c7;white-space:pre-wrap;overflow-wrap:anywhere}.status[data-kind=error]{color:#ffb5a4}.status[data-kind=success]{color:#8ce0c7}.recovery{margin-top:7px}
      .results{display:grid;gap:11px;margin-top:17px}.result{border:1px solid #3b4350;border-radius:9px;background:#242a33;padding:12px 13px}.result-head{font-size:11px;font-weight:700;color:#9acbbe;display:flex;gap:7px;align-items:center}.result-number{color:#7c899a;font-variant-numeric:tabular-nums}.english{font-size:14px;line-height:1.65;margin:7px 0;color:#f0f2f6;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}.korean{font-size:12px;line-height:1.6;color:#a8b6c7;border-top:1px solid #3a424e;padding-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.result-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:10px}.copy,.use{font-size:12px;border:1px solid #4a5463;border-radius:6px;padding:5px 10px;color:#c6d2df;background:transparent}.use{color:#9de4d3;border-color:#52796c;background:#293e36}.copy:hover,.use:hover{filter:brightness(1.2)}
      @keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.generate[aria-busy=true]::before{animation:none}}
    </style>
    <section class="panel" role="dialog" aria-labelledby="composer-title">
      <header class="header"><span class="mark">${PEN}</span><div class="heading" id="composer-title">영어 작성<span class="mode"></span></div><button type="button" class="close" aria-label="작성 창 닫기">×</button></header>
      <div class="content">
        <div class="context" hidden></div>
        <label class="intent-label" for="composer-intent">전달할 내용 / 의도</label>
        <textarea id="composer-intent" maxlength="${Shared.COMPOSER_LIMITS.intent}" placeholder="한국어로 편하게 적어 주세요.&#10;예: 고맙다고 하고, 알려준 방법으로 해본 뒤 결과를 공유하겠다고 해줘."></textarea>
        <div class="input-meta"><span>⌘ / Ctrl + Enter로 추천 · Enter로 줄바꿈</span><span class="counter">0 / 4,000</span></div>
        <button type="button" class="generate" aria-busy="false">추천 3개 만들기</button>
        <div class="status" role="status" aria-live="polite" hidden></div>
        <button type="button" class="small recovery" hidden></button>
        <div class="results" aria-label="영어 추천 문장"></div>
      </div>
    </section>`;
    const $ = (selector) => shadow.querySelector(selector);
    const textarea = $("textarea");
    let recoveryAction = null;
    let composing = false;
    let hasResults = false;
    let busy = false;
    let insertBusy = false;
    let generationBlocked = false;
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (label, className, action) => {
      const node = el("button", className, label);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    };
    function updateControls() {
      $(".generate").disabled = busy || insertBusy || generationBlocked || !textarea.value.trim();
      $(".generate").textContent = busy ? "추천 문장 만드는 중…" : hasResults ? "다시 추천" : "추천 3개 만들기";
      $(".generate").setAttribute("aria-busy", String(busy));
      shadow.querySelectorAll(".use").forEach((node) => { node.disabled = busy || insertBusy; });
      $(".counter").textContent = `${textarea.value.length.toLocaleString("ko-KR")} / 4,000`;
    }
    textarea.addEventListener("input", () => { updateControls(); handlers.onIntent(textarea.value); });
    textarea.addEventListener("compositionstart", () => { composing = true; });
    textarea.addEventListener("compositionend", () => { composing = false; });
    shadow.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); handlers.onClose(); }
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (!$(".generate").disabled) handlers.onGenerate();
      }
    });
    for (const type of ["keyup", "keypress", "paste", "pointerdown", "click"]) {
      shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    $(".close").addEventListener("click", handlers.onClose);
    $(".generate").addEventListener("click", handlers.onGenerate);
    $(".recovery").addEventListener("click", () => recoveryAction?.());

    function messageCard(message, selectable, checked) {
      const card = el("article", `context-card${selectable ? checked ? " selected" : "" : " original"}`);
      const top = el("div", "context-top");
      if (selectable) {
        const label = el("label");
        const input = el("input");
        input.type = "checkbox";
        input.checked = checked;
        input.dataset.contextId = message.id;
        input.setAttribute("aria-label", `${message.author}: ${message.text.slice(0,100)} 문맥으로 선택`);
        input.addEventListener("change", () => handlers.onSelect(message.id, input.checked));
        label.append(input, el("span", "", message.author));
        top.append(label);
      } else top.append(el("span", "", message.author));
      if (message.timestamp) {
        const date = new Date(message.timestamp);
        if (Number.isFinite(date.getTime())) top.append(el("time", "", date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })));
      }
      card.append(top, el("p", "context-text", message.text));
      if (message.text.length > 170 || message.text.split("\n").length > 3) {
        const expand = button("원문 펼치기", "expand", () => {
          card.classList.toggle("expanded");
          expand.textContent = card.classList.contains("expanded") ? "접기" : "원문 펼치기";
          expand.setAttribute("aria-expanded", String(card.classList.contains("expanded")));
        });
        expand.setAttribute("aria-expanded", "false");
        card.append(expand);
      }
      if (message.translation) card.append(el("p", "context-ko", message.translation));
      return card;
    }

    function renderContext(model) {
      const slot = $(".context");
      const activeId = shadow.activeElement?.dataset?.contextId;
      const activeAction = shadow.activeElement?.dataset?.action;
      slot.replaceChildren();
      slot.hidden = !model.reply.active && !model.isThread;
      $(".mode").textContent = model.reply.active ? "직접 답장" : model.isThread ? "스레드에 작성" : "새 글";
      generationBlocked = model.reply.active && !model.reply.message;
      if (model.reply.active) {
        slot.append(el("div", "context-heading", "답장 대상 원글"));
        if (model.reply.message) slot.append(messageCard(model.reply.message, false));
        else slot.append(el("div", "context-error", "답장 원글을 아직 확인할 수 없습니다. Discord의 답장 표시줄을 눌러 원글을 불러와 주세요."));
      } else if (model.isThread) {
        const heading = el("div", "context-heading");
        heading.append(el("span", "", `참고할 스레드 대화 · ${model.selected.size}개 선택`));
        const controls = el("div", "controls");
        const toggle = button(model.selecting ? "선택 마침" : "대화 선택", "small", handlers.onToggleSelection);
        toggle.dataset.action = "selection";
        const clear = button("문맥 없이 작성", "small", handlers.onClearSelection);
        clear.dataset.action = "clear";
        controls.append(toggle, clear);
        heading.append(controls);
        slot.append(heading);
        const list = el("div", "context-list");
        const messages = model.selecting ? model.messages : model.messages.filter((message) => model.selected.has(message.id));
        messages.forEach((message) => list.append(messageCard(message, true, model.selected.has(message.id))));
        if (messages.length) slot.append(list);
        if (model.selecting) {
          slot.append(el("p", "hint", "참고할 글을 선택해 주세요. 이전 대화는 스레드를 위로 스크롤하면 목록에 나타납니다."));
          if (!messages.length) slot.append(el("p", "hint", "현재 불러온 대화에 텍스트 메시지가 없습니다."));
        }
      }
      if (activeId) Array.from(slot.querySelectorAll("input")).find((input) => input.dataset.contextId === activeId)?.focus();
      else if (activeAction) slot.querySelector(`[data-action="${activeAction}"]`)?.focus();
      updateControls();
    }

    function renderSuggestions(suggestions) {
      const slot = $(".results");
      slot.replaceChildren();
      hasResults = suggestions.length > 0;
      suggestions.forEach((suggestion, index) => {
        const card = el("article", "result");
        const heading = el("div", "result-head");
        heading.append(el("span", "result-number", `0${index + 1}`), el("span", "", Shared.REPLY_TONES.find((tone) => tone.id === suggestion.tone)?.label || "추천"));
        const english = el("p", "english", suggestion.en);
        english.lang = "en";
        const korean = el("p", "korean", suggestion.ko);
        korean.lang = "ko";
        const actions = el("div", "result-actions");
        actions.append(button("복사", "copy", () => handlers.onCopy(suggestion.en)), button("이 문장 넣기", "use", () => handlers.onInsert(suggestion.en)));
        card.append(heading, english, korean, actions);
        slot.append(card);
      });
      updateControls();
    }

    function setStatus(message = "", kind = "info", action = null) {
      const status = $(".status");
      status.textContent = message;
      status.hidden = !message;
      status.dataset.kind = kind;
      recoveryAction = action?.run || null;
      $(".recovery").hidden = !action;
      $(".recovery").textContent = action?.label || "";
    }

    updateControls();
    return { host, shadow, panel: $(".panel"), textarea, renderContext, renderSuggestions, setStatus,
      setIntent(value) { textarea.value = value; updateControls(); },
      setLoading(value) { busy = value; updateControls(); },
      setInserting(value) { insertBusy = value; updateControls(); },
      show() { host.style.display = "block"; },
      hide() { host.style.display = "none"; },
      focus() { textarea.focus(); } };
  }

  root.DiscordTranslatorComposerUi = Object.freeze({ createButton, createPopover });
})(globalThis);
