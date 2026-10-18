// Transport recovery is owned by Reed, with at most one continuation and no SDK retry stack.
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

async function retryFixture(t, { recoverOn = 2,holdRecovery=false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "reed-retry-sync-"));
  const data = join(root, "data");
  await mkdir(join(data, "agent"), { recursive: true });
  await writeFile(join(data, "agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 20000 }, retry: RETRY_SETTINGS }));
  const events = [], requests = [];
  let child, sequence = 0, stderr = "", waiters = [];
  let releaseRecovery;const held=new Promise(r=>releaseRecovery=r);
  const server = createServer(async (request, response) => {
    if(request.method==='GET'&&request.url!=='/v1/models'){response.writeHead(404);response.end();return;}
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "retry-model", context_length: 65536, supports_reasoning: true, reasoning_efforts: ["off", "low", "medium"] }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if(requests.length===2&&holdRecovery)await held;
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
    releaseRecovery();
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
  return { events, requests, until, send, command, data, root,releaseRecovery };
}

test('bounded transport recovery keeps the turn running and preserves settings',{timeout:30000},async t=>{
  const f=await retryFixture(t,{holdRecovery:true});const start=f.events.length;
  const prompt=f.send('prompt',{text:'test-连接失败后有界恢复'});
  const recovery=await f.until(e=>e.type==='recovery');
  assert.equal(recovery.turnId,prompt);assert.match(recovery.message,/保持原思考设置/);
  assert.ok(!f.events.slice(start).some(e=>['done','settled','error','retry_start'].includes(e.type)));
  f.releaseRecovery();const result=await f.until(e=>e.id===prompt&&e.type==='done');assert.equal(result.outcome.status,'complete');
  assert.equal(f.requests.length,2);assert.ok(f.requests.every(p=>p.reasoning_effort==='medium'));
  assert.equal(f.events.filter(e=>e.type==='recovery').length,1);
  assert.ok(!f.events.some(e=>e.type==='retry_start'),'SDK重试不能与恢复叠加');
});

test('a refused send during bounded recovery never ends or contaminates the running turn',{timeout:30000},async t=>{
  const f=await retryFixture(t,{holdRecovery:true});const prompt=f.send('prompt',{text:'test-原任务'});
  await f.until(e=>e.type==='recovery');const id=f.send('prompt',{text:'test-不应发送的新消息'});
  const error=await f.until(e=>e.id===id&&e.type==='error');assert.equal(error.busy,true);assert.equal(error.recovering,true);assert.match(error.message,/续接/);
  assert.ok(!f.events.some(e=>e.id===prompt&&e.type==='done'));
  f.releaseRecovery();assert.equal((await f.until(e=>e.id===prompt&&e.type==='done')).outcome.status,'complete');
  assert.equal(f.requests.length,2);assert.ok(!f.requests.some(p=>JSON.stringify(p.messages).includes('test-不应发送的新消息')));
});

test('configured SDK maxRetries cannot expand the one-recovery budget',{timeout:30000},async t=>{
  const f=await retryFixture(t,{recoverOn:99});const prompt=f.send('prompt',{text:'test-预算耗尽'});
  const result=await f.until(e=>e.id===prompt&&e.type==='done');assert.equal(result.outcome.status,'error');assert.equal(result.outcome.code,'upstream_failure');
  assert.equal(f.requests.length,2);assert.equal(f.events.filter(e=>e.type==='recovery').length,1);
  assert.equal(f.events.filter(e=>e.type==='retry_start').length,0);
});

test('stopping bounded recovery cancels the attempt and schedules no orphan retry',{timeout:30000},async t=>{
  const f=await retryFixture(t,{recoverOn:99,holdRecovery:true});const prompt=f.send('prompt',{text:'test-恢复期间停止'});
  await f.until(e=>e.type==='recovery');await f.command('abort',{promptId:prompt});
  const result=await f.until(e=>e.id===prompt&&e.type==='done');assert.equal(result.outcome.status,'aborted');
  f.releaseRecovery();await new Promise(r=>setTimeout(r,100));assert.ok(f.requests.length<=2);
  assert.equal(f.events.filter(e=>e.id===prompt&&e.type==='done').length,1);
  assert.ok(f.events.some(e=>e.type==='session_sync'&&!e.busy));
});
