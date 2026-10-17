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

test('failed HTML edit invalidates a prior pass until corrected and freshly reviewed',async t=>{
  const f=await fixture(t);
  await f.capture(1280,'desktop.png');await f.capture(390,'mobile.png');
  await f.tool.execute('first',f.input());
  assert.equal(f.review.outcome({status:'complete'}).status,'complete');
  const error=await f.handlers.tool_result({toolName:'edit',input:{path:f.file},isError:true,content:[{type:'text',text:'edits.0 must be object'}]});
  assert.equal(error.isError,true);
  assert.match(error.content[0].text,/must be object/);
  assert.match(error.content[1].text,/对象数组/);
  assert.equal(f.review.outcome({status:'complete'}).status,'unverified');
  await assert.rejects(f.tool.execute('invalid',f.input()),/写入或编辑失败/);
  await f.changed();
  // Even a successful same-content write must require fresh visual evidence.
  assert.equal(f.review.outcome({status:'complete'}).status,'unverified');
  await assert.rejects(f.tool.execute('stale',f.input()),/修改后请重新截图/);
  await f.capture(1280,'fixed-desktop.png');await f.capture(390,'fixed-mobile.png');
  await f.tool.execute('fixed',f.input());
  assert.equal(f.review.outcome({status:'complete'}).status,'complete');
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


test("two consecutive browser failures stop further attempts and do not claim verified completion",async t=>{
 const f=await fixture(t);const failed=()=>f.handlers.tool_result({toolName:"browser",input:{action:"preview"},content:[{type:"text",text:"fetch failed"}],isError:true});
 await failed();assert.equal(f.handlers.tool_call({toolName:"browser"}),undefined);
 await failed();const stop=f.handlers.tool_call({toolName:"browser"});assert.equal(stop.block,true);assert.equal(stop.terminate,true);assert.match(stop.reason,/停止重试/);
 await f.changed();assert.match(f.handlers.tool_call({toolName:"browser"}).reason,/停止重试/);assert.equal(await f.settle(),undefined);assert.equal(f.review.outcome({status:"complete"}).status,"unverified");
 f.review.begin("用户新任务");assert.equal(f.handlers.tool_call({toolName:"browser"}),undefined);
});
test("one corrected failure can recover but accumulated failures cannot be bypassed with snapshots",async t=>{
 const f=await fixture(t);const failure=()=>f.handlers.tool_result({toolName:"browser",input:{action:"snapshot"},content:[],isError:true});const success=()=>f.handlers.tool_result({toolName:"browser",input:{action:"snapshot"},content:[],isError:false});
 await failure();await success();assert.equal(f.review.snapshot().reason,null);assert.equal(f.handlers.tool_call({toolName:"browser"}),undefined);
 await failure();await success();await failure();assert.equal(f.handlers.tool_call({toolName:"browser"}).terminate,true);
});

test('review instruction names the real browser actions and disappears when the capability is off',()=>{
 const handlers={};
 const review=createVisualReview({scope:{check:async path=>path}});
 review.begin('x');
 review.extension({on:(name,handler)=>handlers[name]=handler,registerTool(){},appendEntry(){}});
 const full={sections:{}};
 handlers.before_agent_start({prompt:'帮我写一个网页动画',systemPromptOptions:full});
 const fullSection=full.sections.reed_visual_review;
 assert.match(fullSection,/action=screenshot/,'截图必须指向 browser 的 action，而不是不存在的 screenshot 工具');
 assert.match(fullSection,/不存在名为 screenshot 的独立工具/);
 const short={sections:{}};
 handlers.before_agent_start({prompt:'解一道数学题',systemPromptOptions:short});
 assert.match(short.sections.reed_visual_review,/action=screenshot/,'无关轮次也要给出可执行的一行规则');
 assert.doesNotMatch(short.sections.reed_visual_review,/当前验收状态/,'无关轮次不携带完整验收策略');
 const offHandlers={};
 const off=createVisualReview({scope:{check:async path=>path},enabled:()=>false});
 off.begin('x');
 off.extension({on:(name,handler)=>offHandlers[name]=handler,registerTool(){},appendEntry(){}});
 const offOptions={sections:{}};
 offHandlers.before_agent_start({prompt:'帮我写一个网页',systemPromptOptions:offOptions});
 assert.match(offOptions.sections.reed_visual_review,/浏览器能力已在设置中关闭/);
 assert.doesNotMatch(offOptions.sections.reed_visual_review,/action=screenshot/,'能力关闭时不要再让模型去调用不存在的路径');
});
