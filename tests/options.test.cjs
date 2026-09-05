const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const optionsHtml = readFileSync(path.join(projectRoot, "options/options.html"), "utf8");
const optionsCss = readFileSync(path.join(projectRoot, "options/options.css"), "utf8");

test("설정 화면 제목은 줄바꿈 없이 한 줄로 표시한다", () => {
  assert.match(optionsHtml, /<h1>메시지 끝에서 바로 번역<\/h1>/);
  assert.equal(/<h1>[^<]*<br/i.test(optionsHtml), false);
});

test("설정 화면과 매니페스트가 Discord 번역 아이콘을 공유한다", () => {
  assert.match(optionsHtml, /src="\.\.\/icons\/icon-128\.png"/);

  for (const size of [16, 32, 48, 128]) {
    const icon = readFileSync(path.join(projectRoot, "icons", "icon-" + size + ".png"));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

test("설정 화면은 중복된 번역 기능 토글을 표시하지 않는다", () => {
  assert.doesNotMatch(optionsHtml, /id="enabled"|class="switch"/);
});

test("연결 결과가 비어 있어도 작업 버튼 아래 여백을 유지한다", () => {
  assert.match(optionsCss, /\.settings-card\s*{[^}]*padding-bottom:\s*24px;/s);
  assert.match(optionsCss, /\.status\s*{[^}]*margin:\s*15px 28px 0;/s);
});
