import test from 'node:test';
import assert from 'node:assert/strict';
import {foregroundWaitPolicy,validateWaitSettings} from './model-wait.mjs';
import {createRequestFetch} from './stream-diagnostics.mjs';

test('explicit local policy, legacy remote policy, independent overrides and validation',()=>{
  assert.deepEqual(foregroundWaitPolicy(),{idleMs:90000,totalMs:300000});
  assert.deepEqual(foregroundWaitPolicy({deployment:'local'}),{idleMs:0,totalMs:0});
  assert.deepEqual(foregroundWaitPolicy({deployment:'local',foregroundIdleMs:2000}),{idleMs:2000,totalMs:0});
  assert.deepEqual(foregroundWaitPolicy({deployment:'remote',foregroundTotalMs:0}),{idleMs:90000,totalMs:0});
  for(const value of [-1,Infinity,NaN,'0',2147483648])assert.throws(()=>validateWaitSettings({foregroundIdleMs:value}));
  assert.throws(()=>validateWaitSettings({deployment:'auto'}));
  assert.equal(validateWaitSettings({foregroundIdleMs:null},{foregroundIdleMs:100}).foregroundIdleMs,null);
});

test('unlimited silent body reports waiting, survives, resumes and cleans timers',async()=>{
  const phases=[];let upstream;
  const response=await createRequestFetch(async()=>new Response(new ReadableStream({start(c){upstream=c;}})),{idleMs:0,totalMs:0,noticeMs:10,diagnostic:e=>phases.push(e)})('http://fixture');
  const result=response.text();
  await new Promise(r=>setTimeout(r,55));
  assert.ok(phases.some(e=>e.phase==='waiting'&&e.elapsedMs>=10));
  upstream.enqueue(new TextEncoder().encode('继续'));upstream.close();
  assert.equal(await result,'继续');
  const count=phases.length;await new Promise(r=>setTimeout(r,25));assert.equal(phases.length,count);
});

test('total bound stops a continuously active stream; unlimited idle still allows total limit',async()=>{
  let tick;
  const response=await createRequestFetch(async()=>new Response(new ReadableStream({start(c){tick=setInterval(()=>c.enqueue(new Uint8Array([32])),5);},cancel(){clearInterval(tick);}})),{idleMs:0,totalMs:40})('http://fixture');
  try{await assert.rejects(response.text(),e=>e.phase==='total'&&/单次生成时限/.test(e.message));}finally{clearInterval(tick);}
});

test('unlimited body cancellation rejects promptly even when upstream cancel hangs',async()=>{
  const controller=new AbortController();
  const response=await createRequestFetch(async()=>new Response(new ReadableStream({cancel(){return new Promise(()=>{});}})),{idleMs:0,totalMs:0,signal:controller.signal})('http://fixture');
  const result=response.text();controller.abort(new Error('手动停止'));
  await assert.rejects(result,/手动停止/);
});

test('connection limit remains active with unlimited generation',async()=>{
  await assert.rejects(createRequestFetch(()=>new Promise(()=>{}),{idleMs:0,totalMs:0,connectionMs:15})('http://fixture'),e=>e.phase==='connection');
});

test('local request can wait for buffered headers and then complete',async()=>{
  const phases=[];
  const response=await createRequestFetch(async()=>{await new Promise(r=>setTimeout(r,50));return new Response('完成');},{idleMs:0,totalMs:0,connectionMs:0,noticeMs:10,diagnostic:e=>phases.push(e)})('http://fixture');
  assert.equal(await response.text(),'完成');
  assert.ok(phases.some(e=>e.phase==='waiting'));
});
