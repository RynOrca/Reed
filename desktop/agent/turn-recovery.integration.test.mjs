import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function recoveryFixture(t, secondTruncated, malformed = false, thinkingStop = false) {
  const root = await mkdtemp(join(tmpdir(), "reed-turn-recovery-"));
  const requests = [], events = [];
  const recoveryRequest = deferred(), releaseRecovery = deferred();
  const task = "RECOVERY_ORIGINAL_TASK：创建太阳系动画；本测试不写记忆。";
  let child, sequence = 0, stderr = "", waiters = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "recovery-model", context_length: 65536, supports_reasoning: true, reasoning_efforts: ["off", "low", "medium", "high"] }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    const index = requests.length;
    if (index === 2) {
      recoveryRequest.resolve();
      await releaseRecovery.promise;
    }
    const truncated = index === 1 || (index === 2 && secondTruncated);
    response.setHeader("content-type", "text/event-stream");
    const chunk = (delta, finish_reason = null) => ({ id: `recovery-${index}`, object: "chat.completion.chunk", created: 1, model: "recovery-model", choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(truncated ? { reasoning_content: `ISOLATED_THINKING_ATTEMPT_${index}` } : { content: "RECOVERY_VISIBLE_SUCCESS" }))}\n\n`);
    if (malformed && truncated) { response.end('data: {"choices":\n\n'); return; }
    response.write(`data: ${JSON.stringify(chunk({}, truncated && !thinkingStop ? "length" : "stop"))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    releaseRecovery.resolve();
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (child?.exitCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await mkdir(join(root, "data", "agent"), { recursive: true });
  await writeFile(join(root, "data", "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 20000 }, retry: { enabled: false } }));
  const script = process.env.SUMMON_TEST_BRIDGE || join(dirname(fileURLToPath(import.meta.url)), "bridge.mjs");
  child = spawn(process.env.SUMMON_TEST_NODE || process.execPath, [script], { cwd: root, env: { ...process.env, SUMMON_DATA_DIR: join(root, "data"), SUMMON_WORKSPACE: root }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
  function until(predicate) {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter(item => item !== waiter);
        reject(new Error(`Bridge timeout: ${stderr}; recent events: ${JSON.stringify(events.slice(-6))}`));
      }, 15000);
      waiters.push(waiter);
    });
  }
  function command(type, args = {}) {
    const id = `recovery-test-${++sequence}`;
    child.stdin.write(JSON.stringify({ type, id, ...args }) + "\n");
    return until(event => event.id === id && ["ack", "done", "error"].includes(event.type)).then(result => {
      assert.notEqual(result.type, "error", result.message || stderr);
      return result;
    });
  }
  await until(event => event.type === "ready");
  await command("init");
  for (const layer of ["l1", "l2", "l3"]) await command("memory_enabled", { layer, enabled: false });
  const provider = await command("save_provider", { template: "custom", name: "隔离恢复测试", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "openai-completions" });
  await command("discover_models", { providerId: provider.providerId });
  await command("update_model", { providerId: provider.providerId, model: { id: "recovery-model", enabled: true } });
  await command("select_model", { provider: provider.providerId, model: "recovery-model", thinkingLevel: "medium" });
  const sessionId = events.filter(event => event.type === "session").at(-1).sessionId;
  const start = events.length;
  const pending = command("prompt", { text: task });
  await Promise.race([recoveryRequest.promise, until(event => events.indexOf(event) >= start && event.type === "done").then(() => { throw new Error("Turn completed before the recovery request"); })]);
  assert.ok(events.slice(start).some(event => event.type === "recovery"), "恢复应向 UI 发出明确事件");
  assert.ok(!events.slice(start).some(event => ["done", "settled"].includes(event.type)), "恢复请求未返回时不能显示完成");
  if (malformed) assert.ok(!events.slice(start).some(event => event.type === "error"), "可恢复的首次流错误不能提前结束 UI 或留下最终错误提示");
  assert.equal(requests[0].reasoning_effort, "medium");
  assert.equal(requests[1].reasoning_effort, "medium");
  assert.deepEqual(requests[1].messages.filter(m=>['system','developer'].includes(m.role)),requests[0].messages.filter(m=>['system','developer'].includes(m.role)), '续接不能改写system前缀');
  assert.deepEqual(requests[1].tools,requests[0].tools,'续接不能改写工具schema');
  for (const request of requests) {
    assert.equal(request.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(task)).length, 1, "恢复应保留原任务且不能重复输入");
  }
  assert.equal(JSON.stringify(requests[1].messages).includes('ISOLATED_THINKING_ATTEMPT_1'),thinkingStop,'仅完整stop思考保留，损坏或截断思考不复用');
  assert.ok(JSON.stringify(requests[1].messages.at(-1)).includes('Continue the original user task'), '续接指令应在上下文末尾');
  releaseRecovery.resolve();
  const done = await pending;
  if (malformed) {
    const diagnostics = (await readFile(join(root, "data", "request-diagnostics.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(diagnostics.some(entry => entry.type === "malformed_sse" && entry.event === 3), "诊断应观察到真实响应的损坏事件，而不是改写或忽略它");
    assert.ok(!JSON.stringify(diagnostics).includes("ISOLATED_THINKING_ATTEMPT_"));
  }
  assert.equal(requests.length, 2, "同一轮最多请求一次恢复");
  return { events, requests, done, command, sessionId, task, start };
}

test("PI bridge recovers a thinking-only length stop without premature completion", { timeout: 30000 }, async t => {
  const fixture = await recoveryFixture(t, false);
  assert.equal(fixture.done.outcome.status, "complete");
  assert.ok(fixture.events.slice(fixture.start).some(event => event.type === "message_outcome" && event.outcome.stopReason === "length"));
  assert.ok(fixture.events.slice(fixture.start).some(event => event.type === "delta" && event.kind === "text" && event.text === "RECOVERY_VISIBLE_SUCCESS"));
});

test('PI bridge preserves completed thinking-only history and reasoning depth when continuing', {timeout:30000}, async t=>{
  const fixture=await recoveryFixture(t,false,false,true);
  assert.equal(fixture.done.outcome.status,'complete');
});

test('PI bridge ends repeated thinking-only stop after one continuation', {timeout:30000}, async t=>{
  const fixture=await recoveryFixture(t,true,false,true);
  assert.equal(fixture.done.outcome.status,'error');
  assert.equal(fixture.done.outcome.code,'incomplete_reasoning');
  assert.equal(fixture.requests.length,2);
});

test("PI bridge bounds repeated truncation and preserves failed history and original task", { timeout: 30000 }, async t => {
  const fixture = await recoveryFixture(t, true);
  assert.equal(fixture.done.outcome.status, "truncated");
  await fixture.command("open_session", { sessionId: fixture.sessionId });
  const history = fixture.events.filter(event => event.type === "history").at(-1).messages;
  assert.equal(history.filter(message => message.role === "assistant" && message.stopReason === "length").length, 2, "历史应保留两次截断，而非只显示投影上下文");
  await fixture.command("prompt", { text: "RECOVERY_FOLLOW_UP：刚才为何停止？" });
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests[2].reasoning_effort, "medium", "续接不能改变用户的后续思考设置");
  assert.equal(fixture.requests[2].messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes(fixture.task)).length, 1, "追问必须仍包含原始任务");
  assert.ok(!JSON.stringify(fixture.requests[2].messages).includes("ISOLATED_THINKING_ATTEMPT_"));
});

test("PI bridge retries a malformed thinking-only SSE once with the original task", { timeout: 30000 }, async t => {
  const fixture = await recoveryFixture(t, false, true);
  assert.equal(fixture.done.outcome.status, "complete");
  assert.ok(fixture.events.some(event => event.type === "message_outcome" && event.outcome.code === "transport_incomplete"));
});

test("PI bridge reports repeated malformed SSE rather than retrying indefinitely", { timeout: 30000 }, async t => {
  const fixture = await recoveryFixture(t, true, true);
  assert.equal(fixture.done.outcome.status, "error");
  assert.equal(fixture.done.outcome.code, "transport_incomplete");
  assert.equal(fixture.requests.length, 2);
});
