import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRouterLoad,sampleRouterLoad} from './router-load.mjs';
import {cancellationStatus,cancellationApplies} from '../web/cancellation-status.js';

const sample=()=>({object:'router.load',model:'test',router_busy:false,backend:{object:'ninfer.load',model:'test',requests:{admitted:0,running:0,prefilling:0,decode_ready:0,waiting:0,materializing:0},counters:{computed_prefill_tokens:10,committed_decode_tokens:20}}});
test('idle is a validated engine sample, never a request cancellation acknowledgement',()=>{
  const s=sample();const idle=classifyRouterLoad(s,'test');assert.equal(idle.state,'idle');assert.match(idle.message,/不是本次取消确认/);
  s.backend.requests.prefilling=1;assert.equal(classifyRouterLoad(s,'test').state,'prefilling');
  assert.match(classifyRouterLoad(s,'test').message,/其他请求/);
  for(const change of [x=>x.model='other',x=>x.backend.model='other',x=>x.backend_changed=true,x=>delete x.backend.requests.running,x=>x.backend.requests.running=-1]){const d=sample();change(d);assert.equal(classifyRouterLoad(d,'test').state,'unknown');}
});
test('404/501/502/503 and malformed results are unknown, root GET only, sampling bounded',async()=>{
  for(const status of [404,501,502,503]){
    const events=[],calls=[];await sampleRouterLoad({baseUrl:'http://fixture/v1',model:'test',fetchImpl:async(url,init)=>{calls.push([url.pathname,init.method]);return new Response('',{status});},emit:e=>events.push(e),intervalMs:1});
    assert.deepEqual(calls,[['/router/load','GET']]);assert.equal(events[0].state,'unknown');
  }
  const events=[];const busy=sample();busy.router_busy=true;busy.backend.requests.running=1;
  await sampleRouterLoad({baseUrl:'http://fixture/v1',model:'test',fetchImpl:async()=>Response.json(busy),emit:e=>events.push(e),intervalMs:1,maxSamples:3});
  assert.equal(events.length,3);assert.ok(events.every(e=>e.state==='busy'));
});
test('load sampling timeout and new-turn cancellation cannot publish stale idle',async()=>{
  const events=[];
  await sampleRouterLoad({baseUrl:'http://fixture/v1',model:'test',fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),emit:e=>events.push(e),timeoutMs:10});
  assert.equal(events[0].state,'unknown');
  const c=new AbortController();c.abort();let calls=0;
  await sampleRouterLoad({baseUrl:'http://fixture/v1',model:'test',signal:c.signal,fetchImpl:async()=>{calls++;return Response.json(sample());},emit:e=>events.push(e)});
  assert.equal(calls,0);
  assert.equal(cancellationApplies({turnId:'old'},{cancelledTurnId:'old',running:true,stopping:false}),false);
  assert.equal(cancellationApplies({turnId:'old'},{cancelledTurnId:null,running:false}),false);
  assert.equal(cancellationApplies({turnId:'old'},{cancelledTurnId:'old',running:false}),true);
  assert.match(cancellationStatus(),/本地已取消.*未知/);
});
