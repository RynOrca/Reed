import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createVisualReview } from "./visual-review.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "reed-visual-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "index.html");
  await writeFile(file, "<h1>isolated page</h1>");
  const handlers = {}, entries = [], events = [];
  let tool;
  const review = createVisualReview({ scope: { check: async path => path }, send: event => events.push(event), ...options });
  review.begin("创建网页动画");
  review.extension({ on: (name, handler) => handlers[name] = handler, registerTool: t => tool = t, appendEntry: (...entry) => entries.push(entry) });
  const changed = () => handlers.tool_result({ toolName: "write", input: { path: file }, content: [], isError: false });
  await changed();
  async function capture(width, suffix, sourceHash) {
    await handlers.tool_result({ toolName: "browser", input: { action: "screenshot" }, content: [{ type: "image", data: "eA==", mimeType: "image/png" }], details: { width, height: 800, waitMs: 1200, sourcePath: file, sourceHash: sourceHash || createHash("sha256").update(await readFile(file)).digest("hex"), artifactPath: join(root, suffix) }, isError: false });
  }
  const input = () => ({ screenshotPaths: review.snapshot().screenshots.slice(-2).map(s => s.artifactPath), checks: [{ requirement: "运行后轨道与布局正确", passed: true, evidence: "两种视口截图均没有裁切" }], issues: [], passed: true });
  const settle = () => handlers.agent_before_settle({ outcome: "completed", continue: false }, { model: { input: ["text", "image"] }, hasPendingMessages: () => false });
  handlers.turn_end({ message: { role: "assistant", stopReason: "stop" } });
  return { review, tool, handlers, entries, file, changed, capture, input, settle };
}

test("visual completion requires actual screenshots and rejects inconsistent passing assessments", async t => {
  const f = await fixture(t);
  assert.equal((await f.settle()).continue, true);
  await assert.rejects(f.tool.execute("test", { ...f.input(), screenshotPaths: ["invented1", "invented2"] }), /真实截图/);
  await f.capture(1280, "desktop.png");
  await f.capture(390, "mobile.png");
  await assert.rejects(f.tool.execute("test", { ...f.input(), issues: [{ severity: "minor", description: "文字被截断" }] }), /仍有问题/);
  await f.tool.execute("test", f.input());
  assert.equal(await f.settle(), undefined);
  assert.equal(f.review.outcome({ status: "complete" }).status, "complete");
  assert.equal(f.entries.length, 1);
});

test("new edits invalidate both reviews and screenshots, including stale loaded page captures", async t => {
  const f = await fixture(t);
  await f.capture(1280, "desktop.png"); await f.capture(390, "mobile.png");
  await f.tool.execute("test", f.input());
  const oldHash = f.review.snapshot().revisions[0].hash;
  await writeFile(f.file, "<h1>new revision</h1>"); await f.changed();
  await assert.rejects(f.tool.execute("test", f.input()), /修改后请重新截图/);
  await f.capture(1280, "stale.png", oldHash);
  assert.equal(f.review.snapshot().screenshots.length, 2);
  assert.equal(f.review.outcome({ status: "complete" }).status, "unverified");
});

test("stalled reviews are bounded and disabled browser does not claim completion", async t => {
  const f = await fixture(t, { maxNudges: 2 });
  assert.equal((await f.settle()).continue, true);
  assert.equal((await f.settle()).continue, true);
  assert.equal(await f.settle(), undefined);
  assert.match(f.review.outcome({ status: "complete" }).message, /未取得有效进展/);
  const disabled = await fixture(t, { enabled: () => false });
  assert.equal(await disabled.settle(), undefined);
  assert.match(disabled.review.outcome({ status: "complete" }).message, /浏览器能力已关闭/);
});

test("provider errors and user cancellation are not resumed by the visual gate", async t => {
  const f = await fixture(t);
  assert.equal(await f.handlers.agent_before_settle({ outcome: "aborted", continue: false }, {}), undefined);
  f.handlers.turn_end({ message: { role: "assistant", stopReason: "error" } });
  assert.equal(await f.settle(), undefined);
  assert.equal(f.review.outcome({ status: "error" }).status, "error");
});
