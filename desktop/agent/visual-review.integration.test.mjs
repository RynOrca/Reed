import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, defineTool } from "@earendil-works/pi-coding-agent";
import { createVisualReview } from "./visual-review.mjs";
import { AgentBrowser } from "./browser.mjs";

// No external provider or real user files: SDK requests go exclusively to loopback.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=";
async function fixture(t, { images = true, enabled = true, refuse = false, realBrowser = false, invalidWrite = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "reed-visual-sdk-"));
  const agentDir = join(root, "agent"), sessionsDir = join(root, "sessions");
  await Promise.all([mkdir(agentDir), mkdir(sessionsDir)]);
  const html = join(root, "artifact.html"), requests = [], events = [];
  let session, browser;
  const captures = [];
  const call = (name, args, index = 0) => ({ index, id: `tool-${requests.length}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    requests.push(payload);
    let delta, finish = "stop";
    if (requests.length === 1) { delta = { tool_calls: [call("write", { path: html, content: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>isolated visual artifact</title><style>body{margin:0;background:#102030;color:white}main{padding:24px}.orb{width:48px;height:48px;border-radius:50%;background:#ffd060;animation:pulse 1s infinite alternate}@keyframes pulse{to{transform:translateX(50px)}}@media(max-width:480px){main{padding:12px}}</style><main><h1>Isolated visual fixture</h1><div class="orb"></div><p>Desktop and narrow viewport rendering.</p></main>' })] }; finish = "tool_calls"; }
    else if (requests.length === 2 || refuse || !images || !enabled) delta = { content: "I have written the file." };
    else if (realBrowser && requests.length === 3) { delta = { tool_calls: [call("browser", { action: "preview", path: html, viewport: { width: 1280, height: 800 } })] }; finish = "tool_calls"; }
    else if (requests.length === (realBrowser ? 4 : 3)) { delta = { tool_calls: [call("browser", { action: "screenshot", viewport: { width: realBrowser ? 1280 : 1200, height: 800 }, waitMs: 1000 }), call("browser", { action: "screenshot", viewport: { width: 390, height: 844 }, waitMs: 1000 }, 1)] }; finish = "tool_calls"; }
    else if (requests.length === (realBrowser ? 5 : 4)) { delta = { tool_calls: [call("visual_review", { screenshotPaths: captures.map(c => c.artifactPath), checks: [{ requirement: "桌面与窄屏布局以及动画", passed: true, evidence: "已检查两张实际截图" }], issues: [], passed: true })] }; finish = "tool_calls"; }
    else delta = { content: "VISUALLY_VERIFIED" };
    if(invalidWrite && requests.length===1)delta.tool_calls=[call('write',{path:html,content:{invalid:'must be a string'}})];
    res.setHeader("content-type", "text/event-stream");
    const chunk = (d, finish_reason = null) => ({ id: `response-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "isolated-vision", choices: [{ index: 0, delta: d, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    session?.dispose();
    browser?.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    if (realBrowser) await new Promise(done => setTimeout(done, 600));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "isolated-visual": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "isolated-placeholder", models: [{ id: "isolated-vision", name: "Isolated visual test", reasoning: false, input: images ? ["text", "image"] : ["text"], contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const gate = createVisualReview({ scope: { check: async path => { assert.equal(resolve(path), html); return html; } }, send: event => events.push(event), enabled: () => enabled, maxNudges: 2 });
  if (realBrowser) browser = new AgentBrowser(root, { scope: { check: async path => { assert.equal(resolve(path), html); return html; } } });
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, extensionFactories: [gate.extension, pi => {
    pi.registerTool(defineTool({ name: "write", label: "test write", description: "Write isolated HTML", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute(_id, input) { assert.equal(input.path, html); await writeFile(html, input.content); return { content: [{ type: "text", text: "written" }] }; } }));
    pi.registerTool(defineTool({ name: "browser", label: "test screenshot", description: "Return isolated screenshot image", parameters: Type.Object({ action: Type.Union([Type.Literal("preview"), Type.Literal("screenshot")]), path: Type.Optional(Type.String()), viewport: Type.Object({ width: Type.Number(), height: Type.Number() }), waitMs: Type.Optional(Type.Number()) }), async execute(_id, input) {
      if (realBrowser) {
        const result = await browser.run(input);
        if (input.action === "screenshot") captures.push(result.details);
        return result;
      }
      const artifactPath = join(root, `capture-${input.viewport.width}.png`);
      await writeFile(artifactPath, Buffer.from(png, "base64"));
      const details = { artifactPath, width: input.viewport.width, height: input.viewport.height, waitMs: input.waitMs, loadedAt: new Date().toISOString(), sourcePath: html, sourceHash: createHash("sha256").update(await readFile(html)).digest("hex") };
      captures.push(details);
      return { content: [{ type: "image", data: png, mimeType: "image/png" }], details };
    } }));
  }] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("isolated-visual", "isolated-vision"), resourceLoader, settingsManager, sessionManager: SessionManager.create(root, sessionsDir), tools: ["write", "browser", "visual_review"] }));
  gate.begin("创建网页动画并检查桌面和窄屏");
  await session.prompt("创建网页动画并检查桌面和窄屏");
  return { requests, events, gate, session, captures, html };
}

test("真实 PI SDK 在 write 后提前 stop 时继续截图，图片进入下一请求，视觉评审后才通过", { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.requests.length, 5);
  assert.ok(f.events.some(e => e.type === "recovery"));
  const imageBlocks = f.requests[3].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "image_url");
  assert.equal(imageBlocks.length, 2, "截图必须作为模型可见图像传入，而不仅保存路径");
  assert.ok(imageBlocks.every(b => b.image_url.url.startsWith("data:image/png;base64,")));
  assert.equal(f.gate.snapshot().passed, true);
  assert.equal(f.gate.snapshot().rounds, 1);
  assert.equal(f.gate.outcome({ status: "complete" }).status, "complete");
});

test('真实SDK工具参数校验失败后不能把模型的完成声明当作验收通过',{timeout:20000},async t=>{
  const f=await fixture(t,{invalidWrite:true});
  assert.equal(f.requests.length,2);
  await assert.rejects(readFile(f.html),{code:'ENOENT'});
  const result=f.gate.outcome({status:'complete'});
  assert.equal(result.status,'unverified');
  assert.match(result.message,/写入或编辑失败/);
  const toolMessage=f.requests[1].messages.find(m=>m.role==='tool');
  assert.match(JSON.stringify(toolMessage.content),/Validation failed/);
  assert.match(JSON.stringify(f.requests[1].messages),/不能声称修改已完成/);
});

for (const options of [{ images: false }, { enabled: false }]) test(`真实 PI SDK ${options.images === false ? "无图片输入" : "浏览器禁用"}时不能假通过`, { timeout: 20000 }, async t => {
  const f = await fixture(t, options);
  assert.equal(f.requests.length, 2);
  assert.equal(f.gate.snapshot().passed, false);
  assert.equal(f.gate.outcome({ status: "complete" }).status, "unverified");
  assert.match(f.gate.snapshot().reason, options.images === false ? /图片输入/ : /浏览器能力已关闭/);
});

test("真实 PI SDK 持续拒绝截图时有界结束并明确未验收", { timeout: 20000 }, async t => {
  const f = await fixture(t, { refuse: true });
  assert.equal(f.requests.length, 4);
  assert.equal(f.events.filter(e => e.type === "recovery").length, 2);
  assert.equal(f.gate.outcome({ status: "complete" }).status, "unverified");
  assert.match(f.gate.snapshot().reason, /未取得有效进展/);
});

test("真实 PI SDK 和隔离 Edge 完成预览、真实桌面与窄屏 PNG、图片输入、视觉评审闭环", { timeout: 30000,skip:process.env.SUMMON_TEST_EXTERNAL_EDGE!=='1' }, async t => {
  const f = await fixture(t, { realBrowser: true });
  assert.equal(f.requests.length, 6, JSON.stringify({ snapshot: f.gate.snapshot(), tools: f.requests[5]?.messages.filter(m => m.role === "tool") }));
  const images = f.requests[4].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "image_url");
  assert.equal(images.length, 2);
  const dimensions = images.map(image => {
    const buffer = Buffer.from(image.image_url.url.split(",")[1], "base64");
    assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), buffer };
  });
  assert.deepEqual(dimensions.map(({ width, height }) => ({ width, height })), [{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
  for (let i = 0; i < f.captures.length; i++) {
    const capture = f.captures[i];
    assert.equal(capture.sourcePath, f.html);
    assert.equal(capture.sourceHash, createHash("sha256").update(await readFile(f.html)).digest("hex"));
    assert.equal(capture.sourceChanged, false);
    assert.ok(Date.parse(capture.loadedAt));
    assert.deepEqual(await readFile(capture.artifactPath), dimensions[i].buffer);
  }
  assert.equal(f.gate.snapshot().screenshots.length, 2);
  assert.equal(f.gate.snapshot().passed, true);
  assert.equal(f.gate.outcome({ status: "complete" }).status, "complete");
});
