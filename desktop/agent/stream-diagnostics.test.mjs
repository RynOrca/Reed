import test from "node:test";
import assert from "node:assert/strict";
import { createSseObserver, createDiagnosticFetch, createRequestFetch, describeNetworkError, sanitizeErrorText } from "./stream-diagnostics.mjs";

test('request fetch bounds headers and stalled bodies, and honors cancellation', async()=>{
  const never=(_input,{signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  await assert.rejects(createRequestFetch(never,{idleMs:15,totalMs:100})('http://fixture'),/长时间/);
  const phases=[];
  const response=await createRequestFetch(async()=>new Response(new ReadableStream({start(){}})),{idleMs:15,totalMs:100,diagnostic:e=>phases.push(e)})('http://fixture');
  await assert.rejects(response.text(),/长时间/);
  assert.ok(phases.some(e=>e.phase==='headers'));assert.ok(phases.some(e=>e.phase==='timeout'));
  const controller=new AbortController();
  const waiting=createRequestFetch(never,{signal:controller.signal})('http://fixture');
  controller.abort(new DOMException('已停止','AbortError'));await assert.rejects(waiting,/已停止/);
});

test("SSE observer accepts split UTF-8, CRLF, comments and multiline JSON", () => {
  const events = [], observer = createSseObserver(event => events.push(event));
  const wire = new TextEncoder().encode(': heartbeat\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: [DONE]\r\n\r\n');
  for (const byte of wire) observer.push(Uint8Array.of(byte));
  observer.finish();
  assert.deepEqual(events, []);
});

test("SSE observer fingerprints one malformed event without retaining its content", () => {
  const events = [], observer = createSseObserver(event => events.push(event));
  observer.push(new TextEncoder().encode('data: {"private":"PRIVATE_RESPONSE_SENTINEL"\n\ndata: other broken event\n\n'));
  observer.finish();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "malformed_sse");
  assert.equal(events[0].event, 1);
  assert.equal(events[0].hash.length, 64);
  assert.ok(!JSON.stringify(events).includes("PRIVATE_RESPONSE_SENTINEL"));
});

test("SSE observer distinguishes empty data and limits diagnostic buffering", () => {
  for (const [wire, type] of [['data:\n\n', 'malformed_sse'], ['data: '+ 'x'.repeat(600000), 'sse_diagnostic_limit']]) {
    const events = [], observer = createSseObserver(event => events.push(event));
    observer.push(new TextEncoder().encode(wire)); observer.finish();
    assert.equal(events[0].type, type);
    if (type === 'malformed_sse') assert.equal(events[0].empty, true);
  }
});

test("diagnostic fetch passes exact wire bytes, status and headers even when diagnostics fail", async () => {
  const wire = 'data: {broken}\n\n';
  const fetcher = createDiagnosticFetch(async () => new Response(wire, { status: 200, headers: { 'content-type':'text/event-stream', 'x-test':'unchanged' } }), () => { throw new Error('diagnostic failure'); });
  const response = await fetcher('https://example.invalid');
  assert.equal(await response.text(), wire);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-test'), 'unchanged');
});

test("a failed connection is diagnosable without retaining credentials", async () => {
  const described = [];
  const refusal = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED", errno: -4078 }) });
  await assert.rejects(createRequestFetch(async () => { throw refusal; }, { idleMs: 50, totalMs: 100, diagnostic: entry => described.push(entry) })("https://example.invalid/v1/chat/completions?api_key=sk-live-PRIVATEVALUE", { headers: { authorization: "Bearer sk-live-PRIVATEVALUE" } }));
  const record = described.find(entry => entry.phase === "error");
  assert.ok(record?.error, "连接失败必须留下脱敏后的底层错误描述");
  assert.equal(record.error.name, "TypeError");
  assert.equal(record.error.cause.code, "ECONNREFUSED");
  assert.equal(record.error.cause.errno, -4078);
  assert.match(record.error.message, /fetch failed/);
  assert.match(record.error.cause.message, /127\.0\.0\.1:8080/, "可诊断信息必须保留");
  assert.ok(!JSON.stringify(described).includes("PRIVATEVALUE"), "诊断不得写入凭据");
  assert.ok(described.some(entry => entry.phase === "failed"));
});

test("error sanitizing redacts credentials but keeps the failure shape", () => {
  const sanitized = sanitizeErrorText(`request to https://x.invalid/v1?api_key=sk-live-abc123 rewrote Authorization: Basic dXNlcjpwYXNz and token="secret-value" for password=hunter2`);
  assert.ok(!/abc123|dXNlcjpwYXNz|secret-value|hunter2/.test(sanitized), sanitized);
  assert.match(sanitized, /request to/);
  // The name of the credential stays, so the failure is still diagnosable.
  assert.match(sanitized, /api_key/);
  assert.match(sanitized, /Authorization/);
  assert.ok(sanitizeErrorText("x".repeat(900)).length <= 400);
  assert.equal(sanitizeErrorText(undefined), "");
  assert.equal(describeNetworkError(undefined), null);
  const circular = new Error("loop"); circular.cause = circular;
  assert.equal(describeNetworkError(circular).cause, undefined, "循环 cause 不能导致无限展开");
});

// Ordinary transport failures carry no request content, so their text must survive
// intact: over-redaction would defeat the purpose of recording them.
test("error sanitizing keeps the diagnostic text of transport failures", () => {
  for (const sample of ["fetch failed", "Connection error.", "connect ECONNREFUSED 127.0.0.1:8080", "socket hang up", "429 Too Many Requests", "Request timed out after 90000ms", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT"]) {
    assert.equal(sanitizeErrorText(sample), sample);
  }
});

test("error sanitizing masks a partially hidden key and its environment form", () => {
  const redacted = sanitizeErrorText("Invalid API key provided: sk-abc***xyz for OPENAI_API_KEY=sk-proj-abcdefghijklmnop");
  assert.ok(!/sk-abc|sk-proj|abcdefghijklmnop|\*\*\*/.test(redacted), redacted);
  assert.match(redacted, /Invalid API key provided/);
  assert.match(redacted, /OPENAI_API_KEY/);
});
