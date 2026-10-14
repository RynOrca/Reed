// Cancellation must reach a terminal state in every phase: an upstream that
// stalls, a stop pressed with no active turn, and a stop for a turn that already
// ended (stale prompt id). Only synthetic data and a local mock endpoint are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

async function harness(t,{stallBody=false}={}){
  const root=await mkdtemp(join(tmpdir(),'reed-stop-lifecycle-')),data=join(root,'data');
  await mkdir(data);
  let child,seq=0,calls=0,held;
  const seen=[],waiters=new Set();
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'mock',context_window:65536,max_tokens:2048}]}));return;}
    for await(const _chunk of req){}
    calls++;
    if(stallBody&&calls===1){held=res;res.once('close',()=>{});res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const part of [{delta:{role:'assistant',content:'收到'},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write(`data: ${JSON.stringify({id:'mock',choices:[{index:0,...part}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const until=(predicate,ms=6000,from=0)=>{const prior=seen.slice(from).find(predicate);if(prior)return Promise.resolve(prior);return new Promise((resolve,reject)=>{const waiter={predicate,from,resolve};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('missing event: '+predicate));},ms);waiters.add(waiter);});};
  const send=(type,args={})=>{const id=String(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');return id;};
  const command=async(type,args={})=>{const id=send(type,args),event=await until(e=>e.id===id&&['ack','error','done'].includes(e.type));assert.notEqual(event.type,'error',event.message);return event;};
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const provider={id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',contextWindow:65536,maxTokens:2048,reasoning:false}]};
  await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
  await writeFile(join(data,'app-state.json'),JSON.stringify({provider:provider.id,modelId:'mock',projectPath:root}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root,SUMMON_ABORT_ESCALATE_MS:'2000',SUMMON_ABORT_FORCE_MS:'4000'},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  createInterface({input:child.stdout}).on('line',line=>{const event=JSON.parse(line);seen.push(event);const index=seen.length-1;for(const w of [...waiters])if(index>=w.from&&w.predicate(event)){clearTimeout(w.timer);waiters.delete(w);w.resolve(event);}});
  await until(e=>e.type==='ready');await command('init');
  t.after(async()=>{for(const w of waiters)clearTimeout(w.timer);held?.destroy();child?.stdin.end();child?.kill();if(child&&child.exitCode===null)await new Promise(r=>child.once('close',r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  return {seen,until,send,command,root,data,get calls(){return calls;}};
}

test('stop with no active turn returns an authoritative idle state',{timeout:20000},async t=>{
  const h=await harness(t);
  const from=h.seen.length;await h.command('abort');
  const sync=await h.until(e=>e.type==='session_sync'&&e.busy===false,6000,from);
  assert.ok(h.seen.slice(from).some(e=>e.type==='stopping'),'stop is acknowledged as stopping');
  assert.equal(sync.busy,false);
  assert.ok(h.seen.slice(from).some(e=>e.type==='ack'&&!e.stale),'an abort without a prompt id is not stale');
});

test('stop for an already finished turn is stale and still synchronizes the UI',{timeout:20000},async t=>{
  const h=await harness(t);
  const prompt=h.send('prompt',{text:'你好'});
  await h.until(e=>e.id===prompt&&e.type==='done');
  const from=h.seen.length;
  h.send('abort',{promptId:prompt});
  const ack=await h.until(e=>e.type==='ack'&&e.stale===true,6000,from);
  assert.equal(ack.stale,true);
  const sync=await h.until(e=>e.type==='session_sync'&&e.busy===false,6000,from);
  assert.equal(sync.busy,false);
  assert.equal(h.seen.slice(from).some(e=>e.type==='stopping'),false,'a stale stop does not paint a stopping state');
});

test('stopping a stalled upstream ends the turn and frees the input',{timeout:25000},async t=>{
  const h=await harness(t,{stallBody:true});
  const prompt=h.send('prompt',{text:'停一下'});
  await h.until(e=>e.type==='request_phase'&&e.phase==='headers');
  const stopId=h.send('abort',{promptId:prompt});
  const ack=await h.until(e=>e.id===stopId&&e.type==='ack');
  assert.ok(!ack.stale,'the running turn may not be reported as stale');
  const done=await h.until(e=>e.id===prompt&&e.type==='done');
  assert.equal(done.outcome.status,'aborted');
  assert.equal(done.turnId,prompt,'terminal events carry the turn that produced them');
  assert.ok(h.seen.some(e=>e.type==='session_sync'&&e.busy===false&&e.turnId===prompt));
  await h.command('prompt',{text:'再次回复收到'});
  assert.ok(h.seen.some(e=>e.type==='delta'&&e.text==='收到'));
});

test('terminal events are ordered per turn and never leak into the next reply',{timeout:25000},async t=>{
  const h=await harness(t,{stallBody:true});
  const first=h.send('prompt',{text:'第一轮'});
  await h.until(e=>e.type==='request_phase'&&e.phase==='headers');
  h.send('abort',{promptId:first});
  const done=await h.until(e=>e.id===first&&e.type==='done');
  assert.equal(done.turnId,first);
  const second=h.send('prompt',{text:'第二轮'});
  await h.until(e=>e.id===second&&e.type==='started');
  const doneIndex=h.seen.findIndex(e=>e.id===first&&e.type==='done');
  const startedIndex=h.seen.findIndex(e=>e.id===second&&e.type==='started');
  assert.ok(doneIndex<startedIndex,'the first turn settles before the next one starts');
  h.send('abort',{promptId:second});
  const secondDone=await h.until(e=>e.id===second&&e.type==='done');
  assert.equal(secondDone.turnId,second);
});
