import React, { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createEditor, Node } from "slate";
import { Slate, Editable, withReact } from "slate-react";
import { withHistory } from "slate-history";

window.fixture = { editors: {}, submissions: 0, text(kind) {
  return this.editors[kind].children.map((node) => Node.string(node)).join("\n");
} };

function FixtureEditor({ kind, label }) {
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  window.fixture.editors[kind] = editor;
  // Seed a pre-existing draft rather than including test setup in the undo
  // transaction. Slate itself decides how consecutive typing/paste is grouped.
  return <Slate editor={editor} initialValue={[{ type: "paragraph", children: [{ text: kind === "channel" ? "Existing draft. " : "" }] }]}>
    <Editable className="editor_fixture" role="textbox" aria-label={label} spellCheck={false}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          window.fixture.submissions += 1;
        }
      }} />
  </Slate>;
}

for (const kind of ["channel", "thread"]) {
  const scope = document.querySelector(kind === "channel" ? "main.chatContent_fixture" : "section.chatContent_fixture");
  const mount = scope.querySelector(".textArea_fixture");
  const label = mount.querySelector('[role="textbox"]').getAttribute("aria-label");
  mount.replaceChildren();
  createRoot(mount).render(<FixtureEditor kind={kind} label={label} />);
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".reply-action");
  if (!button) return;
  const message = button.closest('[role="article"]');
  const scope = message.closest(".chatContent_fixture");
  scope.querySelectorAll(".replying_fixture").forEach((node) => node.classList.remove("replying_fixture"));
  message.classList.add("replying_fixture");
  scope.querySelector(".replyBar_fixture")?.remove();
  const bar = document.createElement("div");
  bar.className = "replyBar_fixture";
  bar.textContent = "Alex 님에게 답장하는 중";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.setAttribute("aria-label", "답장 취소");
  cancel.textContent = "취소";
  cancel.onclick = () => { bar.remove(); message.classList.remove("replying_fixture"); };
  bar.append(cancel);
  scope.querySelector(".channelTextArea_fixture").prepend(bar);
});
