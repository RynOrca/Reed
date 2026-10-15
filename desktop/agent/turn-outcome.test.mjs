import test from "node:test";
import assert from "node:assert/strict";
import { classifyAssistantOutcome, isRecoverableFailure } from "./turn-outcome.mjs";

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

// The SDK retries these inside the same turn, so the bridge holds the failure back
// instead of publishing it as the end of the turn.
test("transient transport failures are held for the retry while real errors are not", () => {
  for (const errorMessage of [
    "Connection error.",
    "fetch failed",
    "socket hang up",
    "connect ECONNREFUSED 127.0.0.1:8080",
    "429 Too Many Requests",
    "upstream connect error or disconnect/reset before headers",
    "Request timed out",
  ]) assert.equal(isRecoverableFailure({ stopReason: "error", errorMessage }), true, errorMessage);
  for (const errorMessage of [
    "401 Unauthorized: invalid api key",
    "No API key for provider: summon-1",
    "400 Bad Request: messages[1].role must be user or assistant",
    "Cannot persist recovery omission because a projected message has no source entry",
  ]) assert.equal(isRecoverableFailure({ stopReason: "error", errorMessage }), false, errorMessage);
  assert.equal(isRecoverableFailure({ stopReason: "stop", errorMessage: "Connection error." }), false, "只有失败响应可以重试");
  assert.equal(isRecoverableFailure({ stopReason: "error", errorMessage: "" }), false);
  assert.equal(isRecoverableFailure(undefined), false);
});
