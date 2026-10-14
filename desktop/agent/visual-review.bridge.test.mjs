import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

test("真实 bridge 保存未验收结论，切换并重开会话不会把 stop 恢复成完成", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "reed-visual-history-"));
  const dataDir = join(root, "data"), html = join(dataDir, "workspace", "isolated.html");
  await mkdir(join(dataDir, "agent"), { recursive: true });
  const events = [], requests = [];
  let child, sequence = 0, stderr = "", waiters = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "isolated-text-model", context_length: 65536, supports_vision: false, supports_reasoning: false }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    const index = requests.length;
    const chunk = (delta, finish_reason = null) => ({ id: `isolated-${index}`, object: "chat.completion.chunk", created: 1, model: "isolated-text-model", choices: [{ index: 0, delta, finish_reason }] });
    res.setHeader("content-type", "text/event-stream");
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    const delta = index === 1 ? { tool_calls: [{ index: 0, id: "isolated-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: html, content: "<!doctype html><title>Isolated history fixture</title><h1>Not visually verified</h1>" }) } }] } : { content: "文件已生成，但本模型无法查看图片。" };
    res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, index === 1 ? "tool_calls" : "stop"))}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (child?.exitCode === null) { const closed = once(child, "close"); child.kill(); await closed; }
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const script = process.env.SUMMON_TEST_BRIDGE || join(dirname(fileURLToPath(import.meta.url)), "bridge.mjs");
  child = spawn(process.env.SUMMON_TEST_NODE || process.execPath, [script], { cwd: root, env: { ...process.env, SUMMON_DATA_DIR: dataDir, SUMMON_WORKSPACE: root }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const event = JSON.parse(line);
    events.push(event);
    for (const waiter of [...waiters]) if (waiter.predicate(event)) {
      waiters = waiters.filter(w => w !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  });
  function until(predicate) {
    const found = events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => { waiters = waiters.filter(w => w !== waiter); reject(new Error(`Bridge timeout: ${stderr}; events ${JSON.stringify(events.slice(-5))}`)); }, 15000);
      waiters.push(waiter);
    });
  }
  async function command(type, args = {}) {
    const id = `visual-history-${++sequence}`;
    child.stdin.write(JSON.stringify({ type, id, ...args }) + "\n");
    const result = await until(e => e.id === id && ["ack", "done", "error"].includes(e.type));
    assert.notEqual(result.type, "error", result.message || stderr);
    return result;
  }
  await until(e => e.type === "ready");
  await command("init");
  await command("set_approval", { mode: "auto" });
  for (const layer of ["l1", "l2", "l3"]) await command("memory_enabled", { layer, enabled: false });
  const provider = await command("save_provider", { template: "custom", name: "隔离验收历史测试", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: "openai-completions" });
  await command("discover_models", { providerId: provider.providerId });
  await command("update_model", { providerId: provider.providerId, model: { id: "isolated-text-model", enabled: true } });
  await command("select_model", { provider: provider.providerId, model: "isolated-text-model" });
  const sessionId = events.filter(e => e.type === "session").at(-1).sessionId;
  const done = await command("prompt", { text: "创建一个HTML网页，本测试不写入长期记忆。" });
  assert.equal(done.outcome.status, "unverified");
  assert.equal(requests.length, 2);
  assert.match(await readFile(html, "utf8"), /Not visually verified/);
  await command("new_session");
  assert.notEqual(events.filter(e => e.type === "session").at(-1).sessionId, sessionId);
  const reopenStart = events.length;
  await command("open_session", { sessionId });
  const history = events.slice(reopenStart).filter(e => e.type === "history").at(-1).messages;
  const assistant = history.filter(m => m.role === "assistant").at(-1);
  assert.equal(assistant.stopReason, "stop", "保留原始模型结束原因");
  assert.equal(assistant.outcome.status, "unverified", "恢复持久化验收结果，而非从 stop 推断完成");
  assert.match(assistant.outcome.message, /图片输入|视觉验收|浏览器/);
  assert.equal(requests.length, 2, "切换会话不得额外访问模型");
});
