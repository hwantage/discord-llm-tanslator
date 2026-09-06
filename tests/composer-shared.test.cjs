const test = require("node:test");
const assert = require("node:assert/strict");
const Shared = require("../shared.js");
const tones = ["natural", "friendly", "polite"];

test("작성 유형과 문맥 개수가 맞지 않는 요청은 API 호출 전에 거부한다", () => {
  for (const value of [null, { mode: "unknown" }, { mode: "new", intent: "hello", context: [{ text: "hi" }] },
    { mode: "reply", intent: "hello", context: [] }, { mode: "thread", intent: "hello", context: [] }]) {
    assert.throws(() => Shared.sanitizeComposeRequest(value));
  }
});

test("작성 의도, 문맥 길이, 메시지 개수 제한을 적용하고 문맥을 몰래 자르지 않는다", () => {
  const base = { mode: "thread", intent: "감사", context: [{ text: "context" }] };
  assert.throws(() => Shared.sanitizeComposeRequest({ ...base, intent: " " }), { code: "EMPTY_INTENT" });
  assert.throws(() => Shared.sanitizeComposeRequest({ ...base, intent: "가".repeat(4001) }), { code: "INTENT_TOO_LONG" });
  assert.throws(() => Shared.sanitizeComposeRequest({ ...base, context: Array.from({ length: 13 }, () => ({ text: "hello" })) }), { code: "CONTEXT_TOO_LONG" });
  assert.throws(() => Shared.sanitizeComposeRequest({ ...base, context: [{ text: "a".repeat(8001) }, { text: "b".repeat(8000) }] }), { code: "CONTEXT_TOO_LONG" });
  const accepted = Shared.sanitizeComposeRequest({ ...base, context: [{ text: "a".repeat(16000) }] });
  assert.equal(accepted.context[0].text.length, 16000);
});

test("추천은 말투별 영어·한국어 쌍 세 개를 검증하고 정해진 순서로 정렬한다", () => {
  const values = tones.map((tone, index) => ({ tone, en: `Sentence ${index}`, ko: `문장 ${index}` }));
  assert.deepEqual(Shared.validateReplySuggestions([...values].reverse()), values);
  for (const value of [[], [...values, values[0]], values.map((s) => ({ ...s, en: "Same sentence!" })),
    [{ ...values[0], ko: " " }, ...values.slice(1)], [{ ...values[0], tone: "custom" }, ...values.slice(1)]]) {
    assert.throws(() => Shared.validateReplySuggestions(value), { code: "INVALID_SUGGESTIONS" });
  }
});
