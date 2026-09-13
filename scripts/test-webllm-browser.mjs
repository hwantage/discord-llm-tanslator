// Opt-in real GPU smoke test. Downloads ~4.3 GB into an isolated profile and
// uses fixture messages. Never opens the user's Discord session.
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { targetSession } from "./browser-target-session.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retainedProfile = process.env.DISCORD_TRANSLATOR_WEBLLM_TEST_PROFILE;
const profile = retainedProfile || await mkdtemp(path.join(tmpdir(), "discord-webllm-browser-"));
const model = JSON.parse(await readFile(path.join(root, "webllm/model.json"), "utf8"));
const artifacts = path.join(tmpdir(), "discord-webllm-browser-artifacts");
await mkdir(artifacts, { recursive: true });
let executablePath = process.env.DISCORD_TRANSLATOR_BROWSER_EXECUTABLE;
if (!executablePath && process.platform === "darwin") {
  const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  try { await access(brave); executablePath = brave; } catch { /* Playwright Chromium */ }
}
const extensionPath = path.join(root, "dist/chromium");
const launch = () => chromium.launchPersistentContext(profile, {
  headless: true, executablePath, viewport: { width: 1100, height: 1000 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
let context;
let page;
const report = { model: model.id, results: [] };
try {
  context = await launch();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  // Reused profiles can retain an unpacked extension's previous worker code.
  // Reload the extension while preserving the expensive model cache.
  if (retainedProfile) {
    await worker.evaluate(() => chrome.runtime.reload());
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  }
  const extensionId = new URL(worker.url()).host;
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForFunction(() => !document.querySelector("#webllm-model").disabled);
  assert.equal(await page.locator("#provider-webllm").isChecked(), true);
  await page.locator("#webllm-model").selectOption(model.id);
  assert.equal(await page.locator("#api-settings").isVisible(), false);
  await page.screenshot({ path: path.join(artifacts, "webllm-default.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(artifacts, "webllm-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1100, height: 1000 });

  const start = Date.now();
  if (await page.locator("#webllm-test-button").isDisabled()) {
    await page.locator("#download-button").click();
  }
  let previous = "";
  while (Date.now() - start < 660_000) {
    const status = await page.locator("#model-status").innerText();
    if (status !== previous) { process.stdout.write(`${status}\n`); previous = status; }
    if (await page.locator("#model-status").getAttribute("data-kind") === "error") throw new Error(status);
    if (!await page.locator("#webllm-test-button").isDisabled()) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(await page.locator("#webllm-test-button").isDisabled(), false, "Model preparation timed out");
  await page.locator("#webllm-test-button").click();
  await page.waitForFunction(() => /연결 성공|연결 실패/.test(document.querySelector("#webllm-test-result").textContent),
    null, { timeout: 200_000 });
  const result = await page.locator("#webllm-test-result").innerText();
  report.results.push({ kind: "prepare-and-translate", elapsedMs: Date.now() - start, result });
  assert.match(result, /연결 성공/);
  assert.match(result.split("시험 번역: ")[1] || "", /[가-힣]/, "The English greeting must produce Korean output");
  await page.screenshot({ path: path.join(artifacts, "webllm-ready.png"), fullPage: true });
  process.stdout.write(`PASS model preparation and inference (review translation quality separately): ${result}\n`);

  const translationFailures = [];
  for (const text of [
    "has anyone sucessfully got orca working with windows android emulator ?",
    "Can i connect to a running orca instance on a laptop, from another laptop?",
    "Just discovered orca today and I think its great.",
    "You probably want to post this in \u2060questions-and-bug",
    "Hi guys! Non technical guy here building his first SaaS with Orca+OMP+Compound engineering (please don't stone me! 🙂). I have a coding agent + a reviewer (costing me a fortune...) in OMP and they both ploughing through the tasks on hand. I still have to babysit quite a bit. Is there a way to use an agent to orchestrate/coordinate the coding agent+ reviewer? (ie when Compound Engineering stops and akss for input in brainstorm/plan mode, I would like my Claude to step in and weigh in. If Claude can't decide then I step in). I noticed an \"orchestration skill\" can be downloaded in Orca but not sure as per how to use. Thanks!",
    "hi is there a way to clear my cookies and cache and also history for orca built in browser?"
  ]) {
    try {
      const translation = await worker.evaluate(async (text) =>
        requestTranslation(text, { provider: "webllm" }, "translation-regression"), text);
      report.results.push({ kind: "translation-regression", source: text, ...translation });
      process.stdout.write(`Translation: ${JSON.stringify(translation)}\n`);
      assert.match(translation.translatedText, /[가-힣]/);
      assert.doesNotMatch(translation.translatedText, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}]/u,
        "These English fixtures should produce Korean without unrelated scripts");
      assert.doesNotMatch(translation.translatedText, /I cannot access real-time|The context does not provide/i);
      assert.doesNotMatch(translation.translatedText, /(?:\bnote|\bhint|\bexplanation)\s*[:：]/i);
      assert.doesNotMatch(translation.translatedText, /\n\s*\(?[A-Za-z][^\n가-힣]*\)?\s*$/, "No separate English appendix");
    } catch (error) {
      translationFailures.push(`${text}: ${error.message}`);
      report.results.push({ kind: "translation-regression-error", source: text, error: error.message });
      process.stdout.write(`FAIL translation: ${error.message}\n`);
    }
  }

  const bundle = await build({ entryPoints: [path.join(root, "tests/fixtures/composer-editor.jsx")],
    bundle: true, write: false, minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  const html = (await readFile(path.join(root, "tests/fixtures/composer.html"), "utf8"))
    .replace("</body>", '<script src="/fixture.js"></script></body>');
  await context.route("https://discord.com/**", (route) => {
    const js = new URL(route.request().url()).pathname === "/fixture.js";
    return route.fulfill({ contentType: js ? "application/javascript" : "text/html", body: js ? bundle.outputFiles[0].text : html });
  });
  const discord = await context.newPage();
  await discord.goto("https://discord.com/channels/1/100/threads/200");
  await discord.locator('[data-discord-translator-ui="composer-button"]').nth(1).waitFor();
  await discord.locator("main.chatContent_fixture").locator('[data-discord-translator-ui="composer-button"]').getByRole("button").click();
  const popup = discord.locator('[data-discord-translator-ui="composer-popover"]:visible');
  await popup.getByRole("textbox", { name: "전달할 내용 / 의도" }).fill("안녕하세요. 이 프로젝트를 사용해 보고 싶습니다.");
  await popup.getByRole("button", { name: "추천 3개 만들기", exact: true }).click();
  await discord.waitForFunction(() => {
    const host = document.querySelector('[data-discord-translator-ui="composer-popover"]');
    const dialog = host?.shadowRoot;
    return dialog?.querySelectorAll(".result").length === 3 || dialog?.querySelector('.status[data-kind="error"]');
  }, null, { timeout: 200_000 });
  const composeResult = await popup.locator(".panel").innerText();
  report.results.push({ kind: "compose-new", result: composeResult });
  await discord.screenshot({ path: path.join(artifacts, "webllm-compose.png"), fullPage: true });
  assert.equal(await popup.locator(".result").count(), 3, composeResult);
  process.stdout.write("PASS real WebLLM → three bilingual suggestions\n");

  // A new browser process proves we do not depend on a resident GPU engine.
  await context.close();
  context = await launch();
  const restarted = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await restarted.evaluate(() => chrome.offscreen.createDocument({ url: "webllm/host.html", reasons: ["IFRAME_SCRIPTING"], justification: "Verify cached inference in the isolated test profile" }));
  const host = await targetSession(context, "/webllm/host.html");
  await host.send("Network.enable");
  await host.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await restarted.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.blockedNetworkRequests = 0;
    globalThis.fetch = (input, options) => {
      const url = typeof input === "string" ? input : input.url || String(input);
      if (/^https?:/.test(url)) {
        globalThis.blockedNetworkRequests++;
        throw new Error("Network disabled by offline smoke test");
      }
      return original(input, options);
    };
  });
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  const offlineStart = Date.now();
  const offline = await page.evaluate(() => chrome.runtime.sendMessage({ type: "TEST_PROVIDER" }));
  assert.equal(offline.ok, true, JSON.stringify(offline));
  assert.match(offline.result.translatedText, /[가-힣]/);
  assert.equal(await restarted.evaluate(() => globalThis.blockedNetworkRequests), 0);
  assert.deepEqual(host.requests, []);
  report.results.push({ kind: "offline-restart", elapsedMs: Date.now() - offlineStart, result: offline });
  process.stdout.write("PASS cached restart and inference with zero external fetch attempts\n");

  if (!retainedProfile || process.env.DISCORD_TRANSLATOR_WEBLLM_TEST_CLEAR_CACHE === "1") {
    // Verify the documented cleanup in this disposable profile. It must leave
    // saved extension settings and unrelated cache names intact.
    const cleanup = await restarted.evaluate(async () => {
      await chrome.storage.local.set({ cacheCleanupSentinel: "keep-settings" });
      await caches.open("unrelated-test-cache");
      const names = (await caches.keys()).filter((name) => name.startsWith("webllm/"));
      await Promise.all(names.map((name) => caches.delete(name)));
      return { deleted: names, remaining: await caches.keys(),
        settings: await chrome.storage.local.get("cacheCleanupSentinel") };
    });
    assert.ok(cleanup.deleted.includes("webllm/model"));
    assert.ok(cleanup.deleted.includes("webllm/config"));
    assert.ok(cleanup.deleted.includes("webllm/wasm"));
    assert.ok(cleanup.remaining.includes("unrelated-test-cache"));
    assert.equal(cleanup.remaining.some((name) => name.startsWith("webllm/")), false);
    assert.equal(cleanup.settings.cacheCleanupSentinel, "keep-settings");
    report.results.push({ kind: "cache-deletion", ...cleanup });
    process.stdout.write("PASS model cache deletion preserves settings and unrelated caches\n");
  }
  assert.deepEqual(translationFailures, [], translationFailures.join("\n"));
} catch (error) {
  report.error = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(artifacts, "results.json"), JSON.stringify(report, null, 2));
  await context?.close();
  if (!retainedProfile) await rm(profile, { recursive: true, force: true });
  process.stdout.write(`Artifacts: ${artifacts}\n`);
}
