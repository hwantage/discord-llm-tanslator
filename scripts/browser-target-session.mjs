import assert from "node:assert/strict";

// Offscreen documents and sandbox iframes are independent CDP targets, outside
// Playwright's page list. Attach explicitly to verify isolation and block their
// network too, rather than only taking the visible options page offline.
export async function targetSession(context, suffix) {
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send("Target.getTargets");
  const target = targetInfos.find((target) => target.url.endsWith(suffix));
  assert.ok(target, `Missing target ${suffix}`);
  const { sessionId } = await browserSession.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  let sequence = 0;
  const pending = new Map();
  const requests = [];
  browserSession.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === "Network.requestWillBeSent" && /^https?:/.test(message.params.request.url)) requests.push(message.params.request.url);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  return { requests, async send(method, params = {}) {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer });
    });
    await browserSession.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) });
    return result;
  } };
}
