// Uses an isolated browser profile and intercepted Discord-shaped fixture pages.
// No real Discord session, credentials, or messages are accessed by this test.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = await mkdtemp(path.join(tmpdir(), "discord-composer-browser-"));
const artifacts = path.join(tmpdir(), "discord-composer-browser-artifacts");
await mkdir(artifacts, { recursive: true });
const suggestions = [
  { tone: "natural", en: "Thanks for the update.\nI'll review the changes and follow up.", ko: "업데이트 고마워요.\n변경 사항을 확인하고 다시 알려드릴게요." },
  { tone: "friendly", en: "Thanks for fixing it! I'll take a look and let you know.", ko: "고쳐 줘서 고마워요! 살펴보고 알려드릴게요." },
  { tone: "polite", en: "Thank you for resolving this. I'll review it and get back to you.", ko: "해결해 주셔서 감사합니다. 검토한 뒤 다시 말씀드리겠습니다." }
];
const requests = [];
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end(); return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  requests.push(JSON.parse(payload.messages[1].content));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ model: "fixture", choices: [{ message: { content: JSON.stringify({ suggestions }) } }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
let context;
let page;
try {
  let executablePath = process.env.DISCORD_TRANSLATOR_BROWSER_EXECUTABLE;
  if (!executablePath && process.platform === "darwin") {
    const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    try { await access(brave); executablePath = brave; } catch { /* Use Playwright Chromium. */ }
  }
  const extensionPath = path.join(root, "dist/chromium");
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath, viewport: { width: 1440, height: 1050 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const bundle = await build({ entryPoints: [path.join(root, "tests/fixtures/composer-editor.jsx")], bundle: true,
    write: false, minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  const html = (await readFile(path.join(root, "tests/fixtures/composer.html"), "utf8"))
    .replace("</body>", '<script src="/fixture.js"></script></body>');
  await context.route("https://discord.com/**", (route) => {
    const js = new URL(route.request().url()).pathname === "/fixture.js";
    return route.fulfill({ contentType: js ? "application/javascript" : "text/html", body: js ? bundle.outputFiles[0].text : html });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  await worker.evaluate(async (port) => {
    await chrome.storage.local.set({ providerSettings: { provider: "openai-compatible", endpoint: `http://127.0.0.1:${port}/v1`, model: "fixture", apiKey: "" } });
  }, port);
  page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto("https://discord.com/channels/1/100/threads/200");
  await page.waitForFunction(() => Object.keys(window.fixture?.editors || {}).length === 2);
  await page.locator('[data-discord-translator-ui="composer-button"]').nth(1).waitFor();
  assert.equal(await page.locator('[data-discord-translator-ui="composer-button"]').count(), 2);
  const channel = page.locator("main.chatContent_fixture");
  const thread = page.locator("section.chatContent_fixture");
  const popup = () => page.locator('[data-discord-translator-ui="composer-popover"]:visible');
  const open = async (scope) => {
    await scope.locator('[data-discord-translator-ui="composer-button"]').getByRole("button").click();
    await popup().getByRole("dialog").waitFor();
  };
  const generate = async () => {
    await popup().getByRole("textbox", { name: "전달할 내용 / 의도" }).fill("고맙다고 하고 확인한 뒤 다시 알려주겠다고 해줘.");
    await popup().getByRole("button", { name: "추천 3개 만들기", exact: true }).click();
    await popup().locator(".result").nth(2).waitFor();
  };
  await page.waitForFunction(() => window.fixture.text("channel") === "Existing draft. ");
  await open(channel);
  assert.equal(await popup().locator(".context").isVisible(), false);
  await generate();
  assert.equal(requests[0].mode, "new");
  assert.deepEqual(requests[0].context, []);
  await page.screenshot({ path: path.join(artifacts, "new-message.png") });
  await popup().getByRole("button", { name: "이 문장 넣기", exact: true }).first().click();
  await page.waitForFunction((text) => window.fixture.text("channel") === `Existing draft. ${text}`, suggestions[0].en);
  await popup().waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.fixture.text("thread")), "");
  await channel.getByRole("textbox").press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await page.waitForFunction(() => window.fixture.text("channel") === "Existing draft. ");
  process.stdout.write("PASS extension → provider → bilingual suggestions → Slate insertion and undo\n");

  await open(thread);
  await popup().getByRole("checkbox", { name: /Alex: Please let me know/ }).check();
  await popup().getByRole("checkbox", { name: /Jordan: The release notes/ }).check();
  await generate();
  assert.equal(requests[1].mode, "thread");
  assert.equal(requests[1].context.length, 2);
  assert.match(requests[1].context[0].text, /release notes seem/);
  assert.match(requests[1].context[1].text, /anything else/);
  await page.screenshot({ path: path.join(artifacts, "thread-context.png") });
  await popup().getByRole("button", { name: "이 문장 넣기", exact: true }).first().click();
  await page.waitForFunction((text) => window.fixture.text("thread") === text, suggestions[0].en);
  await popup().waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.fixture.text("channel")), "Existing draft. ");
  await thread.getByRole("textbox").press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await page.waitForFunction(() => window.fixture.text("thread") === "");
  process.stdout.write("PASS selected thread context, chronological order, independent composers\n");

  await thread.locator('[data-list-item-id$="-201"]').getByRole("button", { name: "답장", exact: true }).click();
  await open(thread);
  assert.equal(await popup().getByRole("checkbox").count(), 0);
  assert.match(await popup().locator(".context").innerText(), /fixed the workflow/);
  await generate();
  assert.equal(requests[2].mode, "reply");
  assert.equal(requests[2].context.length, 1);
  assert.match(requests[2].context[0].text, /fixed the workflow/);
  await page.screenshot({ path: path.join(artifacts, "direct-reply.png") });
  await popup().getByRole("button", { name: "이 문장 넣기", exact: true }).first().click();
  await page.waitForFunction((text) => window.fixture.text("thread") === text, suggestions[0].en);
  await popup().waitFor({ state: "hidden" });
  assert.equal(await thread.locator(".replyBar_fixture").count(), 1);
  process.stdout.write("PASS direct reply inside thread uses exactly the original message\n");

  await open(thread);
  await page.setViewportSize({ width: 700, height: 720 });
  const bounds = await popup().getByRole("dialog").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 701 && bounds.y + bounds.height <= 721);
  await page.screenshot({ path: path.join(artifacts, "narrow.png") });
  assert.equal(await page.evaluate(() => window.fixture.submissions), 0);
  assert.deepEqual(pageErrors, []);
  process.stdout.write(`PASS narrow layout, no form submissions or page errors\nScreenshots: ${artifacts}\n`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(artifacts, "failure.png") }).catch(() => {});
    console.error("Browser fixture state:", await page.evaluate(() => ({
      text: Object.fromEntries(Object.keys(window.fixture?.editors || {}).map((kind) => [kind, window.fixture.text(kind)])),
      history: window.fixture?.editors.channel.history,
      statuses: Array.from(document.querySelectorAll('[data-discord-translator-ui="composer-popover"]')).map((host) => host.shadowRoot.querySelector(".status").textContent)
    })).catch(() => null));
  }
  throw error;
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
