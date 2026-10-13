import test from "node:test";
import assert from "node:assert/strict";
import { createAuxiliaryCompleter } from "./auxiliary-runtime.mjs";

const model = (overrides = {}) => ({
  provider: "custom",
  id: "qwen3.8-27b-long",
  api: "openai-completions",
  baseUrl: "https://api.example.test/v1",
  reasoning: true,
  compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
  thinkingLevelMap: { low: "low", medium: "medium" },
  ...overrides,
});
const offOptions = { maxTokens: 128, reasoning: "off" };

test("成功后缓存端点能力并持续以 none 调用，不修改原模型", async () => {
  const original = model();
  const seen = [];
  const complete = async (selected, context, options) => {
    seen.push({ selected, context, options });
    return { stopReason: "stop", content: [{ type: "text", text: "ok" }] };
  };
  const auxiliary = createAuxiliaryCompleter(complete);
  const context = { messages: [] };

  await auxiliary(original, context, offOptions);
  await auxiliary(original, context, offOptions);

  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.selected.thinkingLevelMap.off, "none");
    assert.notEqual(call.selected, original);
    assert.equal(call.context, context);
    assert.equal(call.options, offOptions);
  }
  assert.equal(Object.hasOwn(original.thinkingLevelMap, "off"), false);
});

test("明确不支持时原样回退一次并缓存 unsupported", async () => {
  const original = model();
  const seen = [];
  const complete = async selected => {
    seen.push(selected);
    if (seen.length === 1) return { stopReason: "error", errorMessage: "Unsupported parameter reasoning_effort" };
    return { stopReason: "stop" };
  };
  const auxiliary = createAuxiliaryCompleter(complete);

  await auxiliary(original, {}, offOptions);
  await auxiliary(original, {}, offOptions);

  assert.equal(seen.length, 3);
  assert.equal(seen[0].thinkingLevelMap.off, "none");
  assert.equal(seen[1], original, "首次明确拒绝后只回退原请求一次");
  assert.equal(seen[2], original, "unsupported 缓存后后续请求直接使用原模型");
});

test("取消时不回退或缓存，下一次请求仍尝试 none", async () => {
  const original = model();
  const controller = new AbortController();
  const seen = [];
  const complete = async selected => {
    seen.push(selected);
    if (seen.length === 1) {
      controller.abort();
      return { stopReason: "aborted", errorMessage: "aborted" };
    }
    return { stopReason: "stop" };
  };
  const auxiliary = createAuxiliaryCompleter(complete);

  const cancelled = await auxiliary(original, {}, { ...offOptions, signal: controller.signal });
  assert.equal(cancelled.stopReason, "aborted");
  await auxiliary(original, {}, offOptions);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].thinkingLevelMap.off, "none");
  assert.equal(seen[1].thinkingLevelMap.off, "none");
});

test("无关 500 不回退或缓存错误状态", async () => {
  const original = model();
  const seen = [];
  const complete = async selected => {
    seen.push(selected);
    return seen.length === 1
      ? { stopReason: "error", errorMessage: "500 Internal Server Error" }
      : { stopReason: "stop" };
  };
  const auxiliary = createAuxiliaryCompleter(complete);

  const failure = await auxiliary(original, {}, offOptions);
  const success = await auxiliary(original, {}, offOptions);

  assert.equal(failure.errorMessage, "500 Internal Server Error");
  assert.equal(success.stopReason, "stop");
  assert.equal(seen.length, 2, "每次异常都只请求一次");
  assert.ok(seen.every(selected => selected.thinkingLevelMap.off === "none"));
});

test("显式 off 映射、其他协议、非推理模型和非 off 调用原样透传", async () => {
  const seen = [];
  const complete = async (selected, context, options) => {
    seen.push({ selected, context, options });
    return { stopReason: "stop" };
  };
  const auxiliary = createAuxiliaryCompleter(complete);
  const explicit = model({ thinkingLevelMap: { off: "none", low: "low" } });
  const qwen = model({ compat: { thinkingFormat: "qwen-chat-template", supportsReasoningEffort: false } });
  const disabled = model({ reasoning: false });
  const context = {};
  const notOff = { reasoning: "low" };

  await auxiliary(explicit, context, offOptions);
  await auxiliary(qwen, context, offOptions);
  await auxiliary(disabled, context, offOptions);
  await auxiliary(model(), context, notOff);

  assert.equal(seen.length, 4);
  assert.equal(seen[0].selected, explicit);
  assert.equal(seen[1].selected, qwen);
  assert.equal(seen[2].selected, disabled);
  assert.equal(seen[3].selected.reasoning, true);
  assert.equal(Object.hasOwn(seen[3].selected.thinkingLevelMap, "off"), false);
  assert.equal(seen.every(call => call.context === context), true);
  assert.deepEqual(seen.map(call => call.options), [offOptions, offOptions, offOptions, notOff]);
});

test("不同 baseUrl 使用独立能力缓存", async () => {
  const seen = [];
  const complete = async selected => {
    seen.push(selected);
    return { stopReason: "error", errorMessage: "Invalid reasoning_effort: unsupported" };
  };
  const auxiliary = createAuxiliaryCompleter(complete);
  const firstEndpoint = model();
  const secondEndpoint = model({ baseUrl: "https://other.example.test/v1" });

  await auxiliary(firstEndpoint, {}, offOptions);
  await auxiliary(secondEndpoint, {}, offOptions);
  await auxiliary(firstEndpoint, {}, offOptions);

  assert.equal(seen.length, 5, "两个端点分别探测并各自缓存 unsupported");
  assert.equal(seen[0].baseUrl, firstEndpoint.baseUrl);
  assert.equal(seen[1].baseUrl, firstEndpoint.baseUrl, "首端点首次拒绝后原请求回退");
  assert.equal(seen[2].baseUrl, secondEndpoint.baseUrl);
  assert.equal(seen[3].baseUrl, secondEndpoint.baseUrl, "第二端点独立拒绝后原请求回退");
  assert.equal(seen[4], firstEndpoint, "首端点缓存不会污染第二端点，后续直接原请求");
});
