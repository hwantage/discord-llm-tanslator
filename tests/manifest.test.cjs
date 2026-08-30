const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../manifest.json");

test("Chrome 138 또는 Chrome 내장 번역 API에 의존하지 않는다", () => {
  assert.equal(manifest.minimum_chrome_version, undefined);
  assert.equal(JSON.stringify(manifest).includes("Translator"), false);
});

test("콘텐츠 스크립트는 Discord에만 주입된다", () => {
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://discord.com/*"]);
});

test("로컬 주소는 기본 허용하고 원격 API는 런타임 권한으로 요청한다", () => {
  assert.deepEqual(new Set(manifest.host_permissions), new Set([
    "http://localhost/*",
    "http://127.0.0.1/*",
    "https://localhost/*",
    "https://127.0.0.1/*"
  ]));
  assert.deepEqual(new Set(manifest.optional_host_permissions), new Set([
    "http://*/*",
    "https://*/*"
  ]));
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
  assert.equal(manifest.host_permissions.includes("https://*/*"), false);
});

test("확장 아이콘 크기를 모두 선언한다", () => {
  assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  assert.equal(manifest.action.default_icon[16], "icons/icon-16.png");
});

test("Firefox 개인정보 선언에 메시지 본문과 선택적 인증 정보를 포함한다", () => {
  assert.deepEqual(
    new Set(manifest.browser_specific_settings.gecko.data_collection_permissions.required),
    new Set(["websiteContent", "authenticationInfo"])
  );
});

test("소스 매니페스트는 Chromium MV3 배경 실행 방식만 선언한다", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.scripts, undefined);
});
