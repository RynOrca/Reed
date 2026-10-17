import test from 'node:test';
import assert from 'node:assert/strict';
import {createWireAttempt,wireOutcome,createToolLedger} from './provider-wire.mjs';

const frame=obj=>`data: ${JSON.stringify(obj)}\n\n`;
const choice=(delta={},finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const done='data: [DONE]\n\n';
const tool={index:0,id:'call-1',type:'function',function:{name:'write',arguments:'{"path":"test.txt","content":"合成"}'}};
async function fixture(parts,{signal,status=200,contentType='text/event-stream',readError=false}={}){
  const records=[];
  const attempt=createWireAttempt({taskId:'test-task',index:1,model:{id:'test-model',api:'openai-completions'},signal,diagnostic:e=>records.push(e)});
  let pos=0;
  const response=await attempt.fetch(async()=>new Response(new ReadableStream({pull(c){if(pos<parts.length)c.enqueue(typeof parts[pos]==='string'?new TextEncoder().encode(parts[pos++]):parts[pos++]);else if(readError)c.error(new Error('reader failed'));else c.close();}}),{status,headers:{'content-type':contentType,'x-request-id':'req-1'}}))('http://fixture',{body:JSON.stringify({model:'test-model',reasoning_effort:'medium',max_completion_tokens:16384,tools:[{type:'function',function:{name:'write'}}]})});
  let text='',error;
  try{text=await response.text();}catch(e){error=e;}
  return {wire:attempt.snapshot(),text,error,records,attempt};
}

test('normal stop and tool_calls require DONE and EOF; no duplicated visible text',async()=>{
  const f=await fixture([frame(choice({content:'合成正文'},'stop')),frame({usage:{prompt_tokens:120,prompt_tokens_details:{cached_tokens:100},completion_tokens:5}}),done]);
  assert.equal(f.wire.status,'completed');assert.equal(f.wire.transportComplete,true);assert.equal(f.wire.requestId,'req-1');
  assert.equal(f.text.split('合成正文').length-1,1);assert.equal(f.wire.usage.inputTotal,120);assert.equal(f.wire.usage.inputCached,100);
  const t=await fixture([frame(choice({tool_calls:[tool]},'tool_calls')),done]);
  assert.equal(t.wire.status,'completed');assert.equal(t.wire.validToolCallCount,1);assert.match(t.text,/call-1/);
});

test('length with tools wins over tool inference; raw context capacity is preserved',async()=>{
  for(const raw of ['output_limit','context_capacity']){
    const f=await fixture([frame({...choice({tool_calls:[tool]},'tool_calls'),ninfer:{raw_finish_reason:raw,response_status:'limited'}}),done]);
    assert.equal(f.wire.status,'limited');assert.equal(f.wire.rawFinishReason,raw);assert.ok(!f.text.includes('call-1'));assert.match(f.text,/length/);
  }
  const legacy=await fixture([frame(choice({tool_calls:[{...tool,function:{...tool.function,arguments:'{"partial":'}}]},'length')),done]);
  assert.equal(legacy.wire.status,'limited');assert.equal(wireOutcome(legacy.wire).status,'truncated');
  const overwritten=await fixture([frame({...choice({},'length'),ninfer:{raw_finish_reason:'context_capacity'}}),frame({...choice({tool_calls:[tool]},'tool_calls'),ninfer:{raw_finish_reason:'stop_token'}}),done]);
  assert.equal(wireOutcome(overwritten.wire).code,'context_capacity');assert.ok(!overwritten.text.includes('call-1'));
});

test('placeholder, invalid JSON, duplicate call ID and unknown tool cannot be executed',async()=>{
  const variants=[{...tool,function:{name:'malformed_tool_call',arguments:'{"intended_function":"write"}'}},{...tool,function:{name:'write',arguments:'{"partial":'}},{...tool,function:{name:'not_allowed',arguments:'{}'}}];
  for(const item of variants){const f=await fixture([frame(choice({tool_calls:[item]},'tool_calls')),done]);assert.notEqual(f.wire.status,'completed');assert.ok(f.error);assert.ok(!f.text.includes('call-1'));}
  const duplicate=await fixture([frame(choice({tool_calls:[tool,{...tool,index:1}]},'tool_calls')),done]);assert.equal(duplicate.wire.errorCode,'invalid_tool_call');
});

test('SSE error followed by DONE is still incomplete; HTTP 502 retains error code',async()=>{
  const data={error:{code:'incomplete_response',message:'PRIVATE_ERROR'},ninfer:{raw_finish_reason:'stop_token',response_status:'incomplete'}};
  const f=await fixture([frame(choice({reasoning_content:'PRIVATE_THINKING'})),frame(data),done]);
  assert.equal(f.wire.errorCode,'incomplete_response');assert.equal(f.wire.transportComplete,true);assert.equal(f.wire.canPreserveThinking,true);assert.ok(f.error);
  assert.ok(!JSON.stringify(f.records).includes('PRIVATE_'));
  const http=await fixture([JSON.stringify(data)],{status:502,contentType:'application/json'});assert.equal(http.wire.errorCode,'incomplete_response');assert.equal(http.wire.httpStatus,502);
  const badStatus=await fixture([frame(choice({tool_calls:[tool]},'tool_calls')),done],{status:502});assert.notEqual(badStatus.wire.status,'completed');assert.ok(!badStatus.text.includes('call-1'));
});

test('legacy reasoning-only stop is incomplete; cancelled raw stop never succeeds',async()=>{
  const f=await fixture([frame(choice({reasoning_content:'thinking'},'stop')),done]);assert.equal(f.wire.errorCode,'incomplete_reasoning');assert.equal(f.wire.canPreserveThinking,true);
  const c=await fixture([frame({...choice({content:'partial'},'stop'),ninfer:{raw_finish_reason:'cancelled',response_status:'cancelled'}}),done]);assert.equal(wireOutcome(c.wire).status,'aborted');
  for(const raw of ['none','future_value']){const u=await fixture([frame({...choice({content:'text'},'stop'),ninfer:{raw_finish_reason:raw}}),done]);assert.equal(u.wire.errorCode,'unknown_terminal');}
});

test('missing DONE, partial JSON, post-DONE error and reader failure cannot release tools',async()=>{
  for(const parts of [[frame(choice({tool_calls:[tool]},'tool_calls'))],[frame(choice({tool_calls:[tool]},'tool_calls')),'data: {"partial":'],[frame(choice({tool_calls:[tool]},'tool_calls')),done,frame({error:{code:'upstream_failure'}})]]){
    const f=await fixture(parts);assert.equal(f.wire.status,'incomplete');assert.ok(f.error);assert.equal(f.wire.transportComplete,false);
  }
  const f=await fixture([frame(choice({tool_calls:[tool]},'tool_calls'))],{readError:true});assert.equal(f.wire.transportComplete,false);assert.ok(f.error);
});

test('mature SSE parser handles UTF8 split, CRLF, comments, multiline data and event:error',async()=>{
  const bytes=new TextEncoder().encode(': ping\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中文"},"finish_reason":"stop"}]}\r\n\r\n'+done);
  const f=await fixture([...bytes].map(b=>new Uint8Array([b])));assert.equal(f.wire.status,'completed');assert.equal(f.wire.contentBytes,6);
  const e=await fixture(['event: error\ndata: {"code":"upstream_incomplete"}\n\n',done]);assert.equal(e.wire.errorCode,'upstream_incomplete');
});

test('tool ledger permits one call per attempt/id and refuses incomplete or cancelled attempts',()=>{
  const handlers={},records=[];let wire={enforced:true,attempt_id:'a',status:'completed',transportComplete:true};
  createToolLedger({currentAttempt:()=>({snapshot:()=>wire,signal:new AbortController().signal}),diagnostic:e=>records.push(e)})({on:(name,fn)=>handlers[name]=fn});
  const event={toolName:'write',toolCallId:'same'};
  assert.equal(handlers.tool_call(event),undefined);handlers.tool_execution_end({...event,isError:false});assert.equal(handlers.tool_call(event).block,true);
  wire={...wire,attempt_id:'b'};assert.equal(handlers.tool_call(event),undefined,'不同attempt的相同ID不是同一次调用');
  wire={...wire,status:'incomplete'};assert.equal(handlers.tool_call({...event,toolCallId:'new'}).block,true);
  assert.equal(handlers.tool_call({toolName:'malformed_tool_call'}).block,true);assert.equal(records[1].state,'completed');
});

test('heartbeat bytes are not a model delta; invalid UTF8 and missing finish cannot succeed',async()=>{
  const h=await fixture([': heartbeat\n\n',done]);assert.ok(!h.wire.times.firstDelta);assert.ok(h.wire.times.firstByte);assert.equal(h.wire.status,'incomplete');
  const utf=await fixture([new Uint8Array([0xff]),frame(choice({content:'safe'},'stop')),done]);assert.equal(utf.wire.transportComplete,false);
  const missing=await fixture([frame({...choice({content:'text'}),ninfer:{raw_finish_reason:'stop_token',response_status:'completed'}}),done]);assert.equal(missing.wire.status,'incomplete');
});

test('cancel is permanent and late data cannot change the attempt or replay tools',async()=>{
  const c=new AbortController(),records=[];let upstream;
  const attempt=createWireAttempt({model:{id:'mock',api:'openai-completions'},signal:c.signal,diagnostic:e=>records.push(e)});
  const response=await attempt.fetch(async(_url,init)=>{
    assert.ok(init.signal);return new Response(new ReadableStream({start(out){upstream=out;},cancel(){}}),{headers:{'content-type':'text/event-stream'}});
  })('http://fixture',{body:'{}'});
  const text=response.text();c.abort(new Error('test cancel'));await assert.rejects(text,/test cancel/);
  try{upstream.enqueue(new TextEncoder().encode(frame(choice({content:'late'},'stop'))+done));}catch{}
  assert.equal(attempt.snapshot().status,'cancelled');assert.equal(attempt.snapshot().done,false);
  assert.ok(records.some(e=>e.phase==='cancel_requested'));
  const fresh=await fixture([frame(choice({content:'fresh'},'stop')),done]);assert.equal(fresh.wire.status,'completed');
  assert.notEqual(fresh.wire.attempt_id,attempt.snapshot().attempt_id);
});

test('aggregate metadata retains raw outcome without inventing a wire DONE',async()=>{
  const f=await fixture([JSON.stringify({choices:[{index:0,message:{content:'合成'},finish_reason:'stop'}],ninfer:{raw_finish_reason:'stop_token',response_status:'completed'},usage:{prompt_tokens:80,processed_prompt_tokens:20,prompt_tokens_details:{cached_tokens:60},completion_tokens:3}})],{contentType:'application/json'});
  assert.equal(f.wire.status,'completed');assert.equal(f.wire.done,false);assert.equal(f.wire.responseMode,'aggregate');assert.equal(f.wire.usage.inputProcessed,20);
  assert.equal(f.wire.usage.inputTotal,80);assert.equal(f.wire.usage.inputCached,60);
});

test('a planning loop is stopped locally without any time or token limit',async()=>{
  const frames=[];
  for(let i=0;i<400;i++)frames.push(frame(choice({reasoning_content:'Let me write it now.\n'})));
  const looped=await fixture(frames);
  assert.equal(looped.wire.errorCode,'thinking_repetition');
  assert.equal(looped.wire.status,'incomplete');
  assert.equal(looped.wire.thinkingStop.reason,'repetition');
  assert.ok(looped.error,'the stream must error instead of completing');
  const outcome=wireOutcome(looped.wire);
  assert.equal(outcome.status,'error');assert.equal(outcome.code,'thinking_repetition');
  assert.match(outcome.message,/反复复述/);
  assert.ok(!JSON.stringify(looped.records).includes('Let me write'),'diagnostics keep no model text');
});

test('long varied reasoning and its tool call are never interrupted',async()=>{
  const frames=[];
  for(let i=0;i<400;i++)frames.push(frame(choice({reasoning_content:`Step ${i}: check part ${i} then continue.\n`})));
  frames.push(frame(choice({tool_calls:[tool]},'tool_calls')),done);
  const f=await fixture(frames);
  assert.equal(f.wire.status,'completed');
  assert.equal(f.wire.validToolCallCount,1);
  assert.equal(f.wire.thinkingStop,null);
});
