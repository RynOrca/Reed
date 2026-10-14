import test from "node:test";
import assert from "node:assert/strict";
import { createSseObserver, createDiagnosticFetch, createRequestFetch } from "./stream-diagnostics.mjs";

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
