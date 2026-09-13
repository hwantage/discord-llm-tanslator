// Verify both supported unpacked-extension paths without downloading a model.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const model = JSON.parse(await readFile(path.join(root, "webllm/model.json"), "utf8"));
let executablePath = process.env.DISCORD_TRANSLATOR_BROWSER_EXECUTABLE;
if (!executablePath && process.platform === "darwin") {
  const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  try { await access(brave); executablePath = brave; } catch { /* Playwright Chromium */ }
}

for (const directory of [root, path.join(root, "dist/chromium")]) {
  const label = directory === root ? "source root" : "dist/chromium";
  const profile = await mkdtemp(path.join(tmpdir(), "discord-startup-test-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`, { timeout: 15_000 });
    const status = await page.evaluate(() => Promise.race([
      chrome.runtime.sendMessage({ type: "WEBLLM_STATUS" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Background did not respond")), 10_000))
    ]));
    assert.equal(status.ok, true, `${label}: ${JSON.stringify(status)}`);
    assert.equal(status.result.model, model.id);
    assert.equal(status.result.phase, "idle");

    assert.equal((await readdir(path.join(directory, "webllm"))).some((file) => file.endsWith(".wasm")), false);
    const isolated = await worker.evaluate(async () => {
      try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return false; }
      catch { return true; }
    });
    assert.equal(isolated, true, "The privileged background must not compile WASM");
    assert.equal(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length), 0);
    const models = await page.evaluate(() => chrome.runtime.sendMessage({ type: "WEBLLM_MODELS" }));
    assert.equal(models.ok, true);
    assert.equal(models.result.length, 159);
    process.stdout.write(`PASS ${label}: service worker, metadata catalog, zero bundled WASM, no GPU host at startup\n`);
  } catch (error) {
    throw new Error(`${label}: extension startup failed`, { cause: error });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}
