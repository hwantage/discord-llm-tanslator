(function initializeInlineUi() {
  "use strict";

  const Shared = globalThis.DiscordTranslatorShared;
  const UI_ATTRIBUTE = "data-discord-translator-ui";

  function applyButtonSettings(button, settings) {
    const sanitized = Shared.sanitizeUiSettings(settings);
    button.innerHTML = Shared.BUTTON_ICONS.find((icon) => icon.id === sanitized.buttonIcon).markup;
  }

  function applyTranslationSettings(host, settings) {
    const sanitized = Shared.sanitizeUiSettings(settings);
    const theme = Shared.TRANSLATION_THEMES.find((entry) => entry.id === sanitized.translationTheme);
    host.style.setProperty("--dt-color", theme.color);
    host.style.setProperty("--dt-background", theme.background);
    host.style.setProperty("--dt-accent", theme.accent);
    host.style.setProperty("--dt-padding", theme.id === "default" ? "0 0 0 0.58rem" : "0.38rem 0.55rem 0.38rem 0.65rem");
  }

  function createButtonHost(settings) {
    const host = document.createElement("span");
    host.setAttribute(UI_ATTRIBUTE, "button");
    host.setAttribute("contenteditable", "false");
    host.style.marginLeft = "5px";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          vertical-align: 0.04em;
        }

        button {
          appearance: none;
          width: 1.9em;
          height: 1.9em;
          display: inline-grid;
          place-items: center;
          border: 1px solid rgb(181 196 195 / 24%);
          border-radius: 5px;
          padding: 0;
          color: rgb(213 222 221 / 78%);
          background: rgb(78 89 91 / 28%);
          box-shadow: inset 0 1px 0 rgb(255 255 255 / 3%);
          font: 700 0.64em/1 ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif;
          cursor: pointer;
          opacity: 0.86;
          transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease, opacity 120ms ease, transform 120ms ease;
        }

        button svg { width: 1.35em; height: 1.35em; }

        button:hover {
          border-color: rgb(84 226 209 / 45%);
          color: #d8fffa;
          background: rgb(84 226 209 / 9%);
          opacity: 1;
        }

        button:active {
          transform: scale(0.96);
        }

        button:focus-visible {
          outline: 2px solid #7cf0e3;
          outline-offset: 2px;
        }

        button[data-state="loading"] {
          animation: translator-pulse 900ms ease-in-out infinite alternate;
          cursor: progress;
        }

        button[aria-pressed="true"] {
          color: #c9f7f1;
          background: rgb(84 226 209 / 13%);
          border-color: rgb(84 226 209 / 42%);
          opacity: 1;
        }

        @keyframes translator-pulse {
          from { opacity: 0.48; }
          to { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          button { transition: none; }
          button[data-state="loading"] { animation: none; opacity: 0.65; }
        }
      </style>
      <button type="button" aria-label="한국어로 번역" aria-pressed="false" title="한국어로 번역">한</button>
    `;

    const button = shadow.querySelector("button");
    applyButtonSettings(button, settings);
    return { host, button };
  }

  function createTranslationHost(settings) {
    const host = document.createElement("div");
    host.setAttribute(UI_ATTRIBUTE, "translation");
    host.dataset.state = "idle";
    host.setAttribute("contenteditable", "false");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          max-width: 100%;
          margin-top: 0.28rem;
          color: var(--text-normal, #dbdee1);
          font: inherit;
        }

        .translation {
          position: relative;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 0.48rem;
          align-items: start;
          box-sizing: border-box;
          width: 100%;
          max-width: none;
          padding: var(--dt-padding, 0 0 0 0.58rem);
          border-radius: 4px;
          color: var(--dt-color, var(--text-muted, #b5bac1));
          background: var(--dt-background, transparent);
        }

        .translation::before {
          content: "";
          position: absolute;
          inset-block: 0.16rem;
          inset-inline-start: 0;
          width: 2px;
          border-radius: 2px;
          background: var(--dt-accent, #54e2d1);
          opacity: 0.88;
        }

        .label {
          margin-top: 0.12rem;
          color: var(--dt-accent, #54e2d1);
          font: 700 0.64rem/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
          letter-spacing: 0.035em;
          user-select: none;
        }

        [hidden] { display: none !important; }

        .result { min-width: 0; line-height: 1.42; overflow-wrap: anywhere; }

        .body {
          min-width: 0;
          color: inherit;
          font: inherit;
          line-height: 1.42;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }

        .translation[data-state="loading"] .body {
          opacity: 0.64;
        }

        .translation[data-state="error"]::before {
          background: var(--status-danger, #f23f42);
        }

        .translation[data-state="error"] .label {
          color: var(--status-danger, #f23f42);
        }

        .action {
          grid-column: 2;
          justify-self: start;
          appearance: none;
          margin-top: 0.2rem;
          border: 0;
          padding: 0;
          color: var(--dt-accent, #54e2d1);
          background: transparent;
          font: inherit;
          font-size: 0.74rem;
          font-weight: 650;
          line-height: 1.3;
          cursor: pointer;
        }

        .retry {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          vertical-align: -0.2em;
          width: 22px;
          height: 22px;
          margin-inline-start: 5px;
          border: 0;
          border-radius: 4px;
          padding: 3px;
          color: inherit;
          background: transparent;
          opacity: 0.7;
          cursor: pointer;
        }

        .retry svg { width: 14px; height: 14px; }
        .retry:hover { opacity: 1; background: rgb(128 128 128 / 18%); }
        .retry:focus-visible { outline: 2px solid var(--dt-accent, #7cf0e3); outline-offset: 2px; opacity: 1; }
        .retry:disabled { cursor: progress; opacity: 0.4; }

        .action:hover { text-decoration: underline; }
        .action:focus-visible { outline: 2px solid #7cf0e3; outline-offset: 2px; }
      </style>
      <div class="translation" role="status" aria-live="polite" hidden>
        <span class="label">KO</span>
        <span class="result"><span class="body"></span><button class="retry" type="button" aria-label="번역 다시 시도" title="번역 다시 시도" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>
        <button class="action" type="button" hidden>다시 시도</button>
      </div>
    `;

    applyTranslationSettings(host, settings);
    return {
      host,
      retry: shadow.querySelector(".retry"),
      panel: shadow.querySelector(".translation"),
      body: shadow.querySelector(".body"),
      action: shadow.querySelector(".action")
    };
  }

  globalThis.DiscordTranslatorUi = Object.freeze({
    createButtonHost,
    createTranslationHost,
    applyButtonSettings,
    applyTranslationSettings
  });
})();
