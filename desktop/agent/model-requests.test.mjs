import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelRequests,concurrencyLimit} from './model-requests.mjs';
const model={provider:'a',baseUrl:'http://127.0.0.1:1234/v1'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('single-slot serializes foreground and auxiliary requests, promotes waiting foreground',async()=>{
 const scheduler=new ModelRequests(),order=[];
 const release=await scheduler.acquire(model);
 const background=scheduler.run(model,{priority:'background'},async()=>order.push('background'));
 const foreground=scheduler.run(model,{},async()=>order.push('foreground'));
 await tick();assert.deepEqual(order,[]);release();await Promise.all([background,foreground]);assert.deepEqual(order,['foreground','background']);assert.equal(scheduler.endpoints.size,0);
});
test('experimental limit allows two requests but not a third; endpoints are independent',async()=>{
 const providers=[{...model,parallelRequests:true,maxConcurrentRequests:2}];const scheduler=new ModelRequests({providers:()=>providers});
 const a=await scheduler.acquire(model),b=await scheduler.acquire(model);let started=false;
 const waiting=scheduler.run(model,{},async()=>{started=true;});const independent=await scheduler.acquire({...model,baseUrl:'http://127.0.0.1:1235/v1'});
 await tick();assert.equal(started,false);independent();a();await waiting;assert.equal(started,true);b();assert.equal(scheduler.endpoints.size,0);
});
test('duplicate endpoints use strictest capacity and old configuration stays serial',()=>{
 const scheduler=new ModelRequests({providers:()=>[{...model,parallelRequests:true,maxConcurrentRequests:4},{...model,baseUrl:model.baseUrl+'/'}]});
 assert.equal(scheduler.limit(model),1);assert.equal(concurrencyLimit({}),1);assert.equal(concurrencyLimit({parallelRequests:true,maxConcurrentRequests:99}),2);
});
test('aborted queued requests never start; waiting queue is bounded',async()=>{
 const scheduler=new ModelRequests({maxWaiting:1});const release=await scheduler.acquire(model);const controller=new AbortController();let calls=0;
 const cancelled=scheduler.run(model,{signal:controller.signal},()=>{calls++;});const rejected=assert.rejects(cancelled,{name:'AbortError'});
 await assert.rejects(scheduler.acquire(model),/队列已满/);controller.abort();await rejected;release();assert.equal(calls,0);assert.equal(scheduler.endpoints.size,0);
});
test('active abort does not release capacity until underlying operation settles',async()=>{
 const scheduler=new ModelRequests(),gate=deferred(),controller=new AbortController();let nextStarted=false;
 const active=scheduler.run(model,{signal:controller.signal},()=>gate.promise);await tick();controller.abort();
 const next=scheduler.run(model,{},async()=>{nextStarted=true;});await tick();assert.equal(nextStarted,false);gate.resolve();await Promise.all([active,next]);assert.equal(nextStarted,true);
});
test('stream holds capacity until result completion, including result-only compaction consumers',async()=>{
 const scheduler=new ModelRequests(),gate=deferred();
 const stream=await scheduler.stream(model,{},()=>({result:()=>gate.promise,async *[Symbol.asyncIterator](){yield 'delta';await gate.promise;}}));
 let nextStarted=false;const next=scheduler.run(model,{},async()=>{nextStarted=true;});await tick();assert.equal(nextStarted,false);
 const result=stream.result();gate.resolve('done');assert.equal(await result,'done');await next;assert.equal(nextStarted,true);
 // Result and iterator may both release; capacity must not become negative.
 for await(const event of stream)assert.equal(event,'delta');assert.equal(scheduler.endpoints.size,0);
});
test('stream creation and consumption failures release capacity; nested tool requests do not deadlock',async()=>{
 const scheduler=new ModelRequests();await assert.rejects(scheduler.stream(model,{},()=>{throw Error('create');}),/create/);
 const broken=await scheduler.stream(model,{},()=>({result:async()=>{},async *[Symbol.asyncIterator](){throw Error('read');}}));
 await assert.rejects(async()=>{for await(const event of broken){}},/read/);
 const stream=await scheduler.stream(model,{},()=>({result:async()=> 'done',async *[Symbol.asyncIterator](){yield 'toolcall';}}));
 for await(const event of stream)assert.equal(event,'toolcall');assert.equal(await scheduler.run(model,{},async()=> 'auxiliary result'),'auxiliary result');
});
test('increasing capacity wakes queue; decreasing capacity lets existing requests finish',async()=>{
 const provider={...model,parallelRequests:false,maxConcurrentRequests:2},scheduler=new ModelRequests({providers:()=>[provider]});const a=await scheduler.acquire(model);let began=false;let b;
 const pending=scheduler.acquire(model).then(release=>{began=true;b=release;});await tick();assert.equal(began,false);provider.parallelRequests=true;scheduler.refresh();await pending;assert.equal(began,true);
 provider.parallelRequests=false;let third=false;const c=scheduler.run(model,{},async()=>{third=true;});a();await tick();assert.equal(third,false);b();await c;
});


test('early stream iterator return does not falsely free an unfinished provider request',async()=>{
 const scheduler=new ModelRequests(),gate=deferred();const stream=await scheduler.stream(model,{},()=>({result:()=>gate.promise,async *[Symbol.asyncIterator](){yield 'partial';}}));
 for await(const event of stream){assert.equal(event,'partial');break;}
 let began=false;const next=scheduler.run(model,{},async()=>{began=true;});await tick();assert.equal(began,false);gate.resolve('done');await stream.result();await next;
});

test('completion request budget starts after queue, and waiting is visible',async()=>{
 const scheduler=new ModelRequests(),release=await scheduler.acquire(model),states=[];
 const result=scheduler.complete(model,{requestTimeoutMs:20,queueTimeoutMs:1000,onState:s=>states.push(s)},async signal=>{assert.equal(signal.aborted,false);return 'ok';});
 await new Promise(r=>setTimeout(r,60));release();assert.equal(await result,'ok');
 assert.deepEqual(states.map(s=>s.state),['waiting','running']);assert.ok(states[1].queuedMs>=50);
});
test('queue deadline never calls provider; request deadline waits for provider settlement before release',async()=>{
 const scheduler=new ModelRequests(),release=await scheduler.acquire(model);let calls=0;
 await assert.rejects(scheduler.complete(model,{queueTimeoutMs:10,requestTimeoutMs:100},async()=>calls++),e=>e.phase==='queue');assert.equal(calls,0);release();
 let settled=false;await assert.rejects(scheduler.complete(model,{requestTimeoutMs:10},signal=>new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{settled=true;resolve('late');},10),{once:true}))),e=>e.phase==='request');
 assert.equal(settled,true);assert.equal(scheduler.endpoints.size,0);
});
