import test from "node:test";
import assert from "node:assert/strict";
import { createTurnRecovery, summarizeRequest } from "./turn-recovery.mjs";

const privateSystem = "PRIVATE_SYSTEM_SENTINEL";
const privateUser = "PRIVATE_USER_SENTINEL";
const privateCredential = "PRIVATE_CREDENTIAL_SENTINEL";
const thinkingOnly = {
  role: "assistant", stopReason: "length",
  content: [{ type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" }],
  usage: { input: 100, output: 20, totalTokens: 120 },
};

test("malformed SSE recovery excludes visible answers, tool calls, aborts and unrelated errors", () => {
  const recovery = createTurnRecovery({ send() {} });
  recovery.begin();
  const malformed = { ...thinkingOnly, stopReason: "error", errorMessage: "Error reading response: malformed server-sent event JSON." };
  assert.equal(recovery.willRecover(malformed), true);
  assert.equal(recovery.willRecover({ ...malformed, content: [{ type: "text", text: "partial answer" }] }), false);
  assert.equal(recovery.willRecover({ ...malformed, content: [{ type: "toolCall", name: "write" }] }), false);
  assert.equal(recovery.willRecover({ ...malformed, stopReason: "aborted" }), false);
  assert.equal(recovery.willRecover({ ...malformed, errorMessage: "401 invalid API key" }), false);
  assert.equal(recovery.willRecover({ ...malformed, errorMessage: "503 model startup failed" }), false);
});

const cases = [
  {
    name: "Qwen existing thinking toggles and separate budget",
    payload: { enable_thinking: true, chat_template_kwargs: { enable_thinking: true, preserved: 7 }, thinking_budget: 8192 },
    verify(payload) {
      assert.equal(payload.enable_thinking, false);
      assert.deepEqual(payload.chat_template_kwargs, { enable_thinking: false, preserved: 7 });
      assert.equal(payload.thinking_budget, 1024);
    },
  },
  {
    name: "DeepSeek existing thinking type",
    payload: { thinking: { type: "enabled" } },
    verify(payload) { assert.deepEqual(payload.thinking, { type: "disabled" }); },
  },
  {
    name: "Anthropic enabled budget and output effort",
    payload: { thinking: { type: "enabled", budget_tokens: 8192 }, output_config: { effort: "high", preserved: 7 }, system: [{ type: "text", text: privateSystem }] },
    verify(payload) {
      assert.deepEqual(payload.thinking, { type: "enabled", budget_tokens: 1024 });
      assert.deepEqual(payload.output_config, { effort: "low", preserved: 7 });
      assert.equal(payload.system[0].text, privateSystem);
      assert.equal(payload.system.length, 2);
    },
  },
  {
    name: "Anthropic adaptive thinking remains adaptive",
    payload: { thinking: { type: "adaptive" }, output_config: { effort: "high" }, system: privateSystem },
    verify(payload) {
      assert.deepEqual(payload.thinking, { type: "adaptive" });
      assert.equal(payload.output_config.effort, "low");
    },
  },
  {
    name: "Responses effort with string input",
    payload: { reasoning: { effort: "high", summary: "auto" }, instructions: privateSystem, input: privateUser, max_output_tokens: 8192 },
    verify(payload) {
      assert.deepEqual(payload.reasoning, { effort: "low", summary: "auto" });
      assert.equal(payload.input, privateUser);
      assert.equal(payload.max_output_tokens, 8192);
    },
  },
  {
    name: "Chat completions reasoning effort",
    payload: { reasoning_effort: "medium", max_completion_tokens: 16384 },
    verify(payload) {
      assert.equal(payload.reasoning_effort, "low");
      assert.equal(payload.max_completion_tokens, 16384);
    },
  },
];

for (const scenario of cases) {
  test(`public recovery extension adapts ${scenario.name} without persisting changes`, async () => {
    const handlers = new Map(), diagnostics = [], events = [];
    const recovery = createTurnRecovery({ send: event => events.push(event), diagnostic: async event => diagnostics.push(event) });
    recovery.extension({ on: (type, callback) => handlers.set(type, callback) });
    const payload = {
      model: "isolated-model", messages: [{ role: "system", content: privateSystem }, { role: "user", content: privateUser }],
      api_key: privateCredential, headers: { authorization: privateCredential }, ...scenario.payload,
    };
    if ("input" in scenario.payload) delete payload.messages;
    const snapshot = structuredClone(payload);
    recovery.begin();
    assert.strictEqual(await handlers.get("before_provider_request")({ payload }), payload);
    const boundary = await handlers.get("turn_end")({ message: thinkingOnly, messageEntryId: "isolated-failure" });
    assert.deepEqual(boundary, { entries: [{ type: "context_edit", targetId: "isolated-failure", replacement: null }], continue: true });
    const lowered = await handlers.get("before_provider_request")({ payload });
    scenario.verify(lowered);
    assert.deepEqual(payload, snapshot, "重试不得修改调用方的原始请求对象或嵌套字段");
    assert.strictEqual(await handlers.get("before_provider_request")({ payload }), payload, "恢复仅改变一次请求；后续工具轮不得继续降档或插入提示");
    const secondBoundary = await handlers.get("turn_end")({ message: thinkingOnly, messageEntryId: "isolated-second-failure" });
    assert.equal(secondBoundary.continue, false);
    assert.equal(events.filter(event => event.type === "recovery").length, 1);
    recovery.end();
    recovery.begin();
    assert.strictEqual(await handlers.get("before_provider_request")({ payload }), payload, "新用户轮恢复原始思考设置");
    const diagnosticText = JSON.stringify(diagnostics);
    for (const secret of [privateSystem, privateUser, privateCredential, "PRIVATE_REASONING_SENTINEL"]) {
      assert.ok(!diagnosticText.includes(secret), "诊断不能包含提示词、正文、思考或凭据");
    }
    assert.equal(diagnostics.filter(event => event.type === "request")[1].recovery, true);
    assert.equal(diagnostics.at(-1).recovery, false);
    assert.equal(diagnostics.at(-1).request, 1);
  });
}

test("request summary accepts Responses string input and exposes only user length and hash", () => {
  const summary = summarizeRequest({ model: "isolated", instructions: privateSystem, input: privateUser, api_key: privateCredential });
  assert.equal(summary.userMessages.length, 1);
  assert.equal(summary.userMessages[0].length, privateUser.length);
  assert.match(summary.userMessages[0].hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(summary).includes(privateUser));
});
