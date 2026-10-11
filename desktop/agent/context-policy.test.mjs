import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager, SessionManager, ModelRuntime, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { contextBudget, createContextPolicy, estimateContextTokens, protectedUserRequests, validateCompaction } from "./context-policy.mjs";

const model = { provider: "test", id: "isolated", api: "openai-completions", contextWindow: 65536, maxTokens: 16384, reasoning: true };
const userEntry = (id, text) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "reed-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const handlers = new Map(), events = [], diagnostics = [];
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
  const session = { agent: { streamFunction: options.streamFunction }, autoCompactionEnabled: true };
  const policy = createContextPolicy({ dataDir: root, currentSession: () => session, diagnostic: event => diagnostics.push(event), send: event => events.push(event), ...options });
  policy.bindSettings(settings, model);
  policy.extension({ on: (type, fn) => handlers.set(type, fn) });
  return { root, policy, handlers, settings, session, events, diagnostics, ctx: { model } };
}

test("output cap and model switch reserve sufficient space without changing enabled preference", async t => {
  const f = await fixture(t);
  const first = contextBudget(model);
  assert.ok(first.reserveTokens > model.maxTokens);
  assert.equal(f.settings.getCompactionSettings(model).reserveTokens, first.reserveTokens);
  const larger = { ...model, maxTokens: 32768 };
  f.handlers.get("model_select")({ model: larger });
  assert.ok(f.settings.getCompactionSettings(larger).reserveTokens > 32768);
  assert.equal(f.settings.getCompactionEnabled(), true);
  assert.throws(() => contextBudget({ ...model, maxTokens: 65536 }), /没有为输入/);
});

test("full transcript estimate counts normalized tools, Chinese and image input", () => {
  const plain = [{ role: "system", content: "a" }, { role: "user", content: [{ type: "text", text: "中文" }] }];
  const full = [{ ...plain[0], tools: [{ name: "read", description: "file" }] }, { role: "user", content: [...plain[1].content, { type: "image", data: "abc", mimeType: "image/png" }] }];
  assert.ok(estimateContextTokens(full) >= estimateContextTokens(plain) + 4096);
});

test("explicit short keepRecent is respected while reserve cannot undercut output budget", async t => {
  const f = await fixture(t);
  const configured = SettingsManager.inMemory({ compaction: { reserveTokens: 1024, keepRecentTokens: 64 } });
  f.policy.bindSettings(configured, model);
  assert.equal(configured.getCompactionSettings(model).keepRecentTokens, 64);
  assert.ok(configured.getCompactionSettings(model).reserveTokens > model.maxTokens);
});

test("preflight counts system, tool schemas and new prompt, compacts first and never cuts oversized input", async t => {
  const f = await fixture(t);
  let compacted = 0;
  f.session.model = model;
  f.session.systemPrompt = "SYSTEM ".repeat(200);
  f.session.state = { tools: [{ name: "read", parameters: { description: "SCHEMA".repeat(100) } }], messages: [userEntry("old", "中".repeat(47000)).message] };
  f.session.compact = async () => { compacted++; f.session.state.messages = [userEntry("summary", "Goal and original restrictions preserved").message]; };
  await f.policy.preparePrompt("New correction: verify screenshot");
  assert.equal(compacted, 1);
  await assert.rejects(f.policy.preparePrompt("超".repeat(60000)), /消息未被截断/);
  assert.equal(compacted, 1, "不尝试压缩本身已超大且未入历史的新消息");
  f.session.autoCompactionEnabled = false;
  f.session.state.messages = [userEntry("old", "中".repeat(50000)).message];
  await assert.rejects(f.policy.preparePrompt("new"), /自动压缩已关闭/);
});

test("large tool result is retrievable in full while images remain intact and storage failure loses nothing", async t => {
  const f = await fixture(t);
  const image = { type: "image", data: "pixels", mimeType: "image/png" };
  const text = "开始\n" + "日志".repeat(50000) + "\n最后错误";
  const result = await f.handlers.get("tool_result")({ toolName: "mcp_test", toolCallId: "a", content: [{ type: "text", text }, image] }, f.ctx);
  assert.ok(result.content[0].text.length < contextBudget(model).toolTextChars + 1);
  assert.equal(result.content[1], image);
  assert.match(result.content[0].text, /最后错误/);
  const artifact = result.content[0].text.match(/完整内容：(.*?)。可用/s)[1];
  assert.equal(await readFile(artifact, "utf8"), text);
  assert.ok(!JSON.stringify(f.diagnostics).includes("最后错误"));
});

test("old tools shrink only in projection and two recent turns keep tool pairs intact", async t => {
  const f = await fixture(t);
  const result = id => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "x".repeat(10000) }] });
  const messages = [userEntry("1", "original").message, { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read" }] }, result("old"), userEntry("2", "correct").message, result("recent"), userEntry("3", "current").message, result("latest")];
  const projected = (await f.handlers.get("context")({ messages }, f.ctx)).messages;
  assert.ok(projected[2].content[0].text.length <= 4000);
  assert.equal(messages[2].content[0].text.length, 10000);
  assert.equal(projected[2].toolCallId, "old");
  assert.equal(projected[1], messages[1]);
  assert.equal(projected[4], messages[4]);
  assert.equal(projected[6], messages[6]);
});

test("latest requirements are preserved verbatim in bounded checkpoint, never silently chopped", () => {
  const entries = Array.from({ length: 20 }, (_, i) => userEntry(String(i), `correction-${i}`));
  const result = protectedUserRequests(entries);
  assert.equal(result.hashes.length, 9);
  assert.match(result.text, /correction-19/);
  assert.match(result.text, /correction-0\b/);
  assert.doesNotMatch(result.text, /correction-7\b/);
  assert.equal(protectedUserRequests([userEntry("x", "x".repeat(20000))]).oversized, true);
  assert.throws(() => validateCompaction({ summary: " ", firstKeptEntryId: "a", tokensBefore: 1 }), /摘要为空/);
});

test("original objective survives many corrections verbatim; recent priority and omitted hashes are bounded", () => {
  const goal = "ORIGINAL GOAL: solar animation with orbiting moon; no permanent memory";
  const entries = [userEntry("original", goal), ...Array.from({ length: 30 }, (_, i) => userEntry(String(i), `CORRECTION ${i}: label ${i}`))];
  const protectedGoal = protectedUserRequests(entries, 2000);
  assert.ok(protectedGoal.text.includes(goal));
  assert.match(protectedGoal.text, /CORRECTION 29/);
  assert.ok(protectedGoal.text.length <= 2000);
  const constrained = protectedUserRequests(entries, 110);
  assert.match(constrained.text, /CORRECTION 29/);
  assert.ok(constrained.omittedHashes.length > 0);
  assert.ok(constrained.text.length <= 110);
  const repeated = protectedUserRequests([userEntry("a", goal), userEntry("b", goal)]);
  assert.equal(repeated.hashes.length, 1);
  assert.equal(repeated.text.split(goal).length, 2);
});

test("SDK compact rejects truncated, errored, aborted and empty summaries instead of fallback", async t => {
  for (const stopReason of ["length", "error", "aborted", "stop"]) {
    const f = await fixture(t, { streamFunction() {
      const stream = createAssistantMessageEventStream();
      stream.end({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: stopReason === "stop" ? [] : [{ type: "text", text: "INCOMPLETE" }], stopReason, errorMessage: "ISOLATED_FAILURE", usage, timestamp: Date.now() });
      return stream;
    } });
    const event = { reason: "manual", signal: new AbortController().signal, branchEntries: [userEntry("task", "do not write memory")], preparation: { firstKeptEntryId: "task", messagesToSummarize: [userEntry("old", "history").message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: f.settings.getCompactionSettings(model) } };
    const result = await f.handlers.get("session_before_compact")(event, f.ctx);
    // Aborted response must also be rejected even if PI's older helper allows it.
    assert.equal(result.cancel, true, stopReason);
    assert.equal(result.compaction, undefined);
  }
});

test("successful compaction carries latest task, corrections and no-memory constraint through repeated compression", async t => {
  let priorSummary = "";
  const f = await fixture(t, { compactFn: async preparation => ({ summary: `Goal: solar animation. Constraints: do not write memory. Completed: file written. Unverified: screenshot. ${preparation.previousSummary || ""}`, firstKeptEntryId: "current", tokensBefore: 9000 }) });
  for (let i = 0; i < 3; i++) {
    const result = await f.handlers.get("session_before_compact")({ reason: "threshold", signal: new AbortController().signal, preparation: { previousSummary: priorSummary }, branchEntries: [userEntry("original", "Build solar animation; do not write memory"), userEntry("current", `Correction ${i}: labels upright, verify screenshot`)] }, f.ctx);
    assert.match(result.compaction.summary, /do not write memory/);
    assert.match(result.compaction.summary, new RegExp(`Correction ${i}`));
    priorSummary = result.compaction.summary;
    assert.equal((priorSummary.match(/reed-user-requirements:start/g) || []).length, 1, "每次压缩只追加一份原文保护块");
  }
});

test("real AgentSession survives consecutive compactions, preserves tool linkage and refuses a partial checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "reed-context-session-"));
  let session;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), refreshOnCreate: false });
  runtime.registerProvider("test", { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "isolated-test", models: [{ id: "isolated", name: "Isolated", contextWindow: 65536, maxTokens: 16384, input: ["text", "image"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const selected = runtime.getModel("test", "isolated");
  const manager = SessionManager.inMemory(root);
  for (let i = 0; i < 10; i++) {
    manager.appendMessage(userEntry("unused", `TASK ${i}: preserve no-memory constraint. ${"history ".repeat(2500)}`).message);
    manager.appendMessage({ role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, stopReason: "stop", content: [{ type: "text", text: `PROGRESS ${i} ${"done ".repeat(500)}` }], usage, timestamp: Date.now() });
  }
  manager.appendMessage(userEntry("unused", "CURRENT TASK: labels upright; do not write memory; visually verify product").message);
  manager.appendMessage({ role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, stopReason: "toolUse", content: [{ type: "toolCall", id: "verify-call", name: "read", arguments: { path: "artifact.html" } }], usage, timestamp: Date.now() });
  manager.appendMessage({ role: "toolResult", toolCallId: "verify-call", toolName: "read", content: [{ type: "text", text: "VERIFICATION RESULT" }], isError: false, timestamp: Date.now() });
  const policy = createContextPolicy({ dataDir: root, currentSession: () => session });
  policy.bindSettings(settings, selected);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, extensionFactories: [policy.extension] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: selected, sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: [] }));
  const requests = [];
  let partial = false;
  session.agent.streamFunction = (_model, context, options) => {
    requests.push({ messages: structuredClone(context.messages), options });
    const isSummary = options.cacheRetention === "none";
    const response = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, stopReason: partial && isSummary ? "length" : "stop", content: [{ type: "text", text: isSummary ? "Goal: solar animation. Constraints: no-memory; upright labels. In progress: visual verification. Never report unverified work as verified." : "VISIBLE CONTINUATION" }], usage, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: response.stopReason, message: response }); stream.end(response); return stream;
  };
  await session.compact();
  assert.equal(manager.getBranch().filter(entry => entry.type === "compaction").length, 1);
  await session.prompt("CONTINUE CURRENT TASK; keep previous restrictions");
  const normal = requests.filter(request => request.options.cacheRetention !== "none").at(-1);
  const serialized = JSON.stringify(normal.messages);
  assert.match(serialized, /do not write memory/);
  assert.match(serialized, /labels upright/);
  const toolResult = normal.messages.find(message => message.role === "toolResult" && message.toolCallId === "verify-call");
  assert.ok(toolResult);
  assert.ok(normal.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === toolResult.toolCallId)));
  for (let i = 0; i < 3; i++) await session.prompt(`NEW DETAIL ${i}: ${"context ".repeat(2000)}`);
  await session.compact();
  assert.equal(manager.getBranch().filter(entry => entry.type === "compaction").length, 2);
  await session.prompt("VERIFY AFTER SECOND COMPACTION");
  assert.match(JSON.stringify(requests.at(-1).messages), /no-memory/);
  for (let i = 0; i < 3; i++) await session.prompt(`THIRD DETAIL ${i}: ${"context ".repeat(2000)}`);
  partial = true;
  await assert.rejects(session.compact(), /cancelled/i);
  assert.equal(manager.getBranch().filter(entry => entry.type === "compaction").length, 2, "失败不能覆盖已有检查点");
  partial = false;
  await session.prompt("CONTINUE AFTER FAILED COMPACTION");
  assert.match(JSON.stringify(requests.at(-1).messages), /THIRD DETAIL 2/);
});
