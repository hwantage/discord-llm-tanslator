// Isolated options-page check. Set DISCORD_TRANSLATOR_TEST_DOWNLOAD=1 for two
// real model downloads (~418 MB with WASM); never opens the user's Discord session.
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { targetSession } from "./browser-target-session.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(root, "dist/chromium");
const profile = await mkdtemp(path.join(tmpdir(), "discord-model-picker-"));
const artifacts = path.join(root, ".cache/model-picker-checks");
await mkdir(artifacts, { recursive: true });
const realDownload = process.env.DISCORD_TRANSLATOR_TEST_DOWNLOAD === "1";
const A = "SmolLM2-360M-Instruct-q4f16_1-MLC";
const B = "SmolLM2-360M-Instruct-q4f32_1-MLC";
const report = { realDownload, checks: [], translations: [] };
let executablePath = process.env.DISCORD_TRANSLATOR_BROWSER_EXECUTABLE;
if (!executablePath && process.platform === "darwin") {
  const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  try { await access(brave); executablePath = brave; } catch { /* Playwright Chromium */ }
}
const launch = () => chromium.launchPersistentContext(profile, { headless: true, executablePath,
  viewport: { width: 1120, height: 1100 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") return response.writeHead(404).end();
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ model: "local-fixture", choices: [{ message: { content: "Hello, nice to meet you." } }] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let context;
let page;
let worker;
async function openOptions() {
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/options/options.html`);
  await page.waitForFunction(() => !document.querySelector("#webllm-model").disabled);
}
async function selectModel(id) {
  await page.locator("#webllm-model").selectOption(id);
  await page.waitForFunction((id) => document.querySelector("#webllm-model").value === id, id);
}
async function download(id) {
  await selectModel(id);
  await page.locator("#download-button").click();
  if (id === A) {
    await page.close();
    await openOptions();
    await page.locator("#provider-webllm").check();
    await selectModel(id);
  }
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 660_000) {
    const status = await page.evaluate((modelId) => chrome.runtime.sendMessage({ type: "WEBLLM_STATUS", modelId }), id);
    assert.equal(status.ok, true);
    if (status.result.message !== last) { last = status.result.message; process.stdout.write(`${id}: ${last}\n`); }
    if (status.result.phase === "error") throw new Error(status.result.message);
    if (status.result.cached && status.result.phase === "ready") {
      assert.equal(status.result.cachedShards, status.result.totalShards);
      await page.waitForFunction(() => !document.querySelector("#webllm-test-button").disabled);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Download timed out: ${id}`);
}
async function testModel(id) {
  await selectModel(id);
  await page.waitForFunction(() => !document.querySelector("#webllm-test-button").disabled);
  await page.locator("#webllm-test-button").click();
  await page.waitForFunction(() => /연결 성공|연결 실패/.test(document.querySelector("#webllm-test-result").textContent), null, { timeout: 180_000 });
  const text = await page.locator("#webllm-test-result").innerText();
  assert.match(text, /연결 성공/);
  assert.ok(text.includes(id));
  report.translations.push({ model: id, text });
}
try {
  context = await launch();
  context.on("console", (message) => {
    if (message.type() === "error") process.stdout.write(`Browser: ${message.text()}\n`);
  });
  await openOptions();
  const models = await page.evaluate(() => chrome.runtime.sendMessage({ type: "WEBLLM_MODELS" }));
  assert.equal(models.result.length, 159);
  assert.equal(models.result.some((model) => model.modelType === 1), false);
  assert.equal(await page.locator("#model-filter option[value=embedding]").count(), 0);
  assert.equal(await page.locator("#webllm-model option").count(), 159);
  assert.equal(models.result.every((model) => !model.cached), true);
  assert.equal(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length), 0);
  assert.equal(await page.locator("#webllm-test-button").isDisabled(), true);
  const colors = await page.locator(".provider-choice").evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor));
  assert.notEqual(colors[0], colors[1]);
  await page.screenshot({ path: path.join(artifacts, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifacts, "mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1120, height: 1100 });
  await page.locator("#provider-webllm").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#provider-api").isChecked(), true);
  assert.equal(await page.locator("#api-settings").isVisible(), true);
  await page.locator("#endpoint").fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.locator("#model").fill("local-fixture");
  await page.locator("#api-test-button").click();
  await page.waitForFunction(() => document.querySelector("#api-test-result").textContent.includes("연결 성공"));
  await page.screenshot({ path: path.join(artifacts, "api.png"), fullPage: true });
  await page.locator("#advanced-settings summary").click();
  await page.screenshot({ path: path.join(artifacts, "api-advanced.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifacts, "api-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1120, height: 1100 });
  await page.locator("#advanced-settings summary").click();
  report.checks.push("159-model catalog without embeddings, radio keyboard navigation, mobile layout, local API test");
  await page.locator("#provider-webllm").check();
  await page.locator("#model-search").fill("SmolLM2-360M");
  assert.ok(await page.locator("#webllm-model option").count() < 159);
  await page.locator("#model-search").fill("");
  await selectModel(A);
  if (realDownload) {
    await download(A);
    await testModel(A);
    await download(B);
    await testModel(B);
    const sandbox = await targetSession(context, "/webllm/sandbox.html");
    const capabilities = await sandbox.send("Runtime.evaluate", { returnByValue: true,
      expression: "({secure:isSecureContext,gpu:!!navigator.gpu,extensionApi:!!(globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id)})" });
    assert.deepEqual(capabilities.result.value, { secure: true, gpu: true, extensionApi: false });
    const states = await page.evaluate(async (ids) => Promise.all(ids.map((modelId) => chrome.runtime.sendMessage({ type: "WEBLLM_STATUS", modelId }))), [A, B]);
    assert.equal(states[0].result.loaded, false);
    assert.equal(states[1].result.loaded, true);
    assert.equal(states.every((state) => state.result.cached), true);
    const wasmUrls = await page.evaluate(async () => (await (await caches.open("webllm/wasm")).keys()).map((request) => request.url));
    assert.deepEqual(wasmUrls.sort(), models.result.filter((model) => [A, B].includes(model.id)).map((model) => model.wasmUrl).sort());
    report.checks.push("only the two selected WASM libraries downloaded; settings alone creates no GPU host");
    await page.locator("#model-filter").selectOption("downloaded");
    assert.equal(await page.locator("#webllm-model option").count(), 2);
    await testModel(A);
    await page.screenshot({ path: path.join(artifacts, "downloaded.png"), fullPage: true });
    await context.close();
    context = await launch();
    await context.setOffline(true);
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await worker.evaluate(() => chrome.offscreen.createDocument({ url: "webllm/host.html", reasons: ["IFRAME_SCRIPTING"], justification: "Verify cached model startup in the isolated test profile" }));
    const host = await targetSession(context, "/webllm/host.html");
    await host.send("Network.enable");
    await host.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await worker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        if (/^https?:/.test(String(input?.url || input))) throw new Error("Unexpected network request with cached models");
        return original(input, init);
      };
    });
    await openOptions();
    assert.equal(await page.locator("#webllm-model").inputValue(), A);
    await testModel(A);
    await testModel(B);
    assert.deepEqual(host.requests, [], "Cached inference must not attempt any external download");
    const stored = await page.evaluate(() => chrome.storage.local.get("providerSettings"));
    assert.equal(stored.providerSettings.model, "local-fixture");
    report.checks.push("two selective downloads, options closed during download, model switch/unload, downloaded filter, settings persistence, isolated GPU without extension APIs, cold restart and cached switching with zero HTTP requests from the offscreen host");
  }
  process.stdout.write(`PASS ${report.checks.join("; ")}\n`);
} catch (error) {
  report.error = error.stack;
  await page?.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify(report, null, 2));
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
