import test from "node:test";
import assert from "node:assert/strict";
import { classifyAssistantOutcome } from "./turn-outcome.mjs";

test("length remains truncated even with partial text or tool arguments", () => {
  for (const content of [
    [{ type: "thinking", thinking: "unfinished reasoning" }],
    [{ type: "text", text: "partial response" }],
    [{ type: "toolCall", name: "write", arguments: { path: "partial" } }],
  ]) assert.equal(classifyAssistantOutcome({ stopReason: "length", content }).status, "truncated");
});

test("thinking-only and whitespace responses cannot complete a turn", () => {
  const outcome = classifyAssistantOutcome({ stopReason: "stop", content: [
    { type: "thinking", thinking: "reasoning" }, { type: "text", text: "  \n" },
  ] });
  assert.equal(outcome.status, "empty");
  assert.equal(outcome.hasThinking, true);
  assert.equal(outcome.hasText, false);
  assert.equal(classifyAssistantOutcome(undefined).status, "empty");
});

test("normal tools and text succeed while abort and error remain distinct", () => {
  assert.equal(classifyAssistantOutcome({ stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }).status, "complete");
  assert.equal(classifyAssistantOutcome({ stopReason: "stop", content: [{ type: "text", text: "done" }] }).status, "complete");
  assert.equal(classifyAssistantOutcome({ stopReason: "aborted", content: [{ type: "text", text: "partial" }] }).status, "aborted");
  const failed = classifyAssistantOutcome({ stopReason: "error", errorMessage: "provider failed", content: [] });
  assert.equal(failed.status, "error");
  assert.equal(failed.message, "provider failed");
});
