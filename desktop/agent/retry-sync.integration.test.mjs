// A transient provider failure is retried by the SDK inside the same turn. These
// cases pin the UI contract for that window: the intermediate failure is never
// published as a terminal error, the input stays locked, and only the turn's own
// settlement restores the idle state. Every request goes to a local mock server.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const ANSWER = "连接恢复后的回复内容。";
// Small enough to keep the case fast while exercising the real backoff path.
const RETRY_SETTINGS = { enabled: true, maxRetries: 3, baseDelayMs: 40 };

async function retryFixture(t, { recoverOn = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "reed-retry-sync-"));
  const data = join(root, "data");
  await mkdir(join(data, "agent"), { recursive: true });
  await writeFile(join(data, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 20000 }, retry: RETRY_SETTINGS }));
  const events = [], requests = [];
  let child, sequence = 0, stderr = "", waiters = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "retry-model", context_length: 65536, supports_reasoning: true, reasoning_efforts: ["off", "low", "medium"] }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (requests.length < recoverOn) {
      // The connection dies before any response header: the same transport failure
      // that the OpenAI client reports as "Connection error.".
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => ({ id: "retry-mock", object: "chat.completion.chunk", model: "retry-model", created: 1, choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({ content: ANSWER }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (child?.exitCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  child = spawn(process.execPath, [fileURLToPath(new URL("./bridge.mjs", import.meta.url))], { cwd: root, env: { ...process.env, SUMMON_DATA_DIR: data, SUMMON_WORKSPACE: root }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const event = JSON.parse(line);
    events.push(event);
    for (const waiter of [...waiters]) if (waiter.predicate(event)) {
      waiters = waiters.filter(item => item !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  });
  const until = (predicate, ms = 20000) => {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter(item => item !== waiter);
        reject(new Error(`Bridge timeout: ${stderr}; recent events: ${JSON.stringify(events.slice(-6))}`));
      }, ms);
      waiters.push(waiter);
    });
  };
  const send = (type, args = {}) => { const id = `retry-test-${++sequence}`; child.stdin.write(JSON.stringify({ type, id, ...args }) + "\n"); return id; };
  const command = async (type, args = {}) => {
    const id = send(type, args);
    const event = await until(item => item.id === id && ["ack", "error", "done"].includes(item.type));
    assert.notEqual(event.type, "error", event.message || stderr);
    return event;
  };
  await until(event => event.type === "ready");
  await command("init");
  for (const layer of ["l1", "l2", "l3"]) await command("memory_enabled", { layer, enabled: false });
  const provider = await command("save_provider", { template: "custom", name: "隔离重试测试", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "openai-completions" });
  await command("discover_models", { providerId: provider.providerId });
  await command("update_model", { providerId: provider.providerId, model: { id: "retry-model", enabled: true } });
  await command("select_model", { provider: provider.providerId, model: "retry-model", thinkingLevel: "medium" });
  return { events, requests, until, send, command, data, root };
}

test("a retried connection failure never closes the turn early", { timeout: 40000 }, async t => {
  const fixture = await retryFixture(t);
  const start = fixture.events.length;
  const prompt = fixture.send("prompt", { text: "隔离重试：连接失败后应自动重连。" });
  const firstRetry = await fixture.until(event => event.type === "retry_start");
  const during = fixture.events.slice(start);

  assert.equal(firstRetry.turnId, prompt, "重试事件必须携带它所属的轮次");
  assert.equal(firstRetry.attempt, 1);
  assert.equal(firstRetry.maxAttempts, RETRY_SETTINGS.maxRetries);
  assert.match(firstRetry.message, /自动重连/);
  assert.ok(during.some(event => event.type === "request_phase" && event.phase === "failed"), "连接失败必须被诊断记录");
  assert.ok(!during.some(event => event.type === "error"), "重试期间不能把中间失败当作终态错误发给界面");
  assert.ok(!during.some(event => ["done", "settled"].includes(event.type)), "重试期间不能宣告本轮结束");

  const done = await fixture.until(event => event.id === prompt && event.type === "done");
  assert.equal(done.outcome.status, "complete");
  assert.equal(fixture.requests.length, 2, "只重试一次就成功");
  assert.equal(fixture.requests.filter(request => JSON.stringify(request.messages).includes("隔离重试：连接失败后应自动重连。")).length, 2, "重试保留原任务");

  const terminal = fixture.events.slice(start);
  assert.equal(terminal.filter(event => event.type === "retry_end").length, 1);
  const ended = terminal.find(event => event.type === "retry_end");
  assert.equal(ended.success, true);
  assert.equal(ended.turnId, prompt);
  assert.ok(!terminal.some(event => event.type === "error"), "整轮结束后也不能留下中间失败的错误提示");
  const doneIndex = terminal.findIndex(event => event.id === prompt && event.type === "done");
  const syncIndex = terminal.findIndex(event => event.type === "session_sync" && event.busy === false && event.turnId === prompt);
  assert.ok(syncIndex >= 0 && syncIndex < doneIndex, "空闲状态先于轮次结束事件送达");
  assert.ok(terminal.some(event => event.type === "delta" && event.text === ANSWER), "恢复后的回复内容必须送达");

  const diagnostics = (await readFile(join(fixture.data, "request-diagnostics.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const failed = diagnostics.find(entry => entry.type === "request_phase" && entry.phase === "failed");
  assert.ok(failed, "连接失败应留有一条诊断");
  const described = diagnostics.find(entry => entry.type === "request_phase" && entry.phase === "error" && entry.error);
  assert.ok(described, "连接失败应记录脱敏后的底层错误描述");
  assert.ok(["Error", "TypeError"].includes(described.error.name) || typeof described.error.name === "string");
  assert.ok(described.error.message.length > 0, "底层错误描述必须保留可诊断的信息");
  assert.ok(!JSON.stringify(diagnostics).includes("隔离重试：连接失败后应自动重连。"), "诊断不得写入用户原文");
});

test("a refused send during a retry keeps the turn and reports why", { timeout: 40000 }, async t => {
  const fixture = await retryFixture(t);
  const prompt = fixture.send("prompt", { text: "隔离重试：重试期间再次发送。" });
  await fixture.until(event => event.type === "retry_start");
  const start = fixture.events.length;
  const rejected = fixture.send("prompt", { text: "第二条消息" });
  const error = await fixture.until(event => event.id === rejected && event.type === "error");
  assert.equal(error.busy, true, "拒绝发送必须说明后台仍在运行");
  assert.equal(error.retrying, true, "拒绝发送必须说明正在进行自动重连");
  assert.equal(error.commandType, "prompt");
  assert.match(error.message, /自动重连/);
  assert.ok(!fixture.events.slice(start).some(event => ["done", "settled"].includes(event.type)), "拒绝第二次发送不能结束第一轮");

  const done = await fixture.until(event => event.id === prompt && event.type === "done");
  assert.equal(done.outcome.status, "complete");
  assert.equal(fixture.requests.length, 2, "被拒绝的发送不能额外请求模型");
  assert.ok(!fixture.requests.some(request => JSON.stringify(request.messages).includes("第二条消息")), "被拒绝的消息不能进入上下文");
});

test("an exhausted retry budget settles the turn with the failure", { timeout: 40000 }, async t => {
  const fixture = await retryFixture(t, { recoverOn: 99 });
  const start = fixture.events.length;
  const prompt = fixture.send("prompt", { text: "隔离重试：重试预算耗尽。" });
  const done = await fixture.until(event => event.id === prompt && event.type === "done");
  assert.equal(done.outcome.status, "error");
  assert.equal(done.outcome.message, "Connection error.");
  const terminal = fixture.events.slice(start);
  assert.equal(terminal.filter(event => event.type === "retry_start").length, RETRY_SETTINGS.maxRetries, "每一次重试都要报给界面");
  const ends = terminal.filter(event => event.type === "retry_end");
  assert.equal(ends.length, 1, "重试结束只报一次");
  assert.equal(ends[0].success, false);
  assert.equal(fixture.requests.length, RETRY_SETTINGS.maxRetries + 1, "最多请求 1 + maxRetries 次");
  const doneIndex = terminal.findIndex(event => event.id === prompt && event.type === "done");
  for (const index of terminal.map((event, position) => (event.type === "retry_start" ? position : -1)).filter(position => position >= 0)) {
    assert.ok(index < doneIndex, "重试状态必须在轮次结束前送达");
  }
  assert.ok(!terminal.some(event => event.type === "error"), "重试期间不发布终态错误，失败由轮次结果统一报告");
});

test("stopping during a retry ends the turn without a stuck notice", { timeout: 40000 }, async t => {
  const fixture = await retryFixture(t, { recoverOn: 99 });
  const start = fixture.events.length;
  const prompt = fixture.send("prompt", { text: "隔离重试：重试期间停止。" });
  await fixture.until(event => event.type === "retry_start");
  const stop = fixture.send("abort", { promptId: prompt });
  const ack = await fixture.until(event => event.id === stop && event.type === "ack");
  assert.ok(!ack.stale, "正在重试的轮次不能被当作过期停止");
  const done = await fixture.until(event => event.id === prompt && event.type === "done");
  assert.equal(done.outcome.status, "aborted");
  const terminal = fixture.events.slice(start);
  assert.ok(!terminal.some(event => event.type === "retry_end" && event.success === true), "用户停止不能报告为连接已恢复");
  assert.ok(terminal.some(event => event.type === "session_sync" && event.busy === false && event.turnId === prompt));
});
