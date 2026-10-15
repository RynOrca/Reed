// The window may only return to "就绪" when the Agent reports that the whole turn
// is over. These cases pin the decisions that the retry-state events drive, so a
// reconnecting turn can never look finished while it is still running.
import test from "node:test";
import assert from "node:assert/strict";
import { retryStarted, retryEnded, turnStillRunning, terminalErrorMessage } from "../web/turn-state.mjs";

test("a started retry keeps the turn running and names the reconnect", () => {
  const started = retryStarted({ turnId: "prompt-3", attempt: 2, maxAttempts: 3, delayMs: 4000, message: "模型服务连接失败，正在自动重连（第 2 次）…" });
  assert.equal(started.running, true);
  assert.equal(started.attempts, 2);
  assert.equal(started.maxAttempts, 3);
  assert.match(started.status, /自动重连/);
  // A retry event without a message must still describe itself.
  assert.match(retryStarted({ attempt: 1 }).status, /自动重连|连接/);
  assert.equal(retryStarted(undefined).running, true);
});

test("ending a retry never ends the turn, and reports failure separately", () => {
  assert.deepEqual(retryEnded({ success: true, exhausted: false }), { running: true, reconnecting: false, recovered: true, notice: "" });
  const failed = retryEnded({ success: false, exhausted: true, message: "自动重连仍未成功，正在结束本轮。" });
  assert.equal(failed.running, true, "重试结束不等于本轮结束");
  assert.equal(failed.recovered, false);
  assert.match(failed.notice, /自动重连/);
  assert.equal(retryEnded(undefined).running, true);
});

test("only an Agent that reports nothing running may close the turn", () => {
  assert.equal(turnStillRunning({ busy: true, retrying: true }), true);
  assert.equal(turnStillRunning({ busy: true, commandType: "prompt" }), true);
  assert.equal(turnStillRunning({ busy: false, commandType: "prompt" }), false);
  assert.equal(turnStillRunning({ id: "x", commandType: "prompt" }), false);
  assert.equal(turnStillRunning(undefined), false);
  assert.equal(terminalErrorMessage({ message: "Connection error." }), "Connection error.");
  assert.equal(terminalErrorMessage({}), "PI Agent 出错");
});
