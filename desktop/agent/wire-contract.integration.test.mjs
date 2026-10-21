import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const frame=obj=>`data: ${JSON.stringify(obj)}\n\n`;
const chunk=(delta={},finish_reason=null)=>({id:'mock',choices:[{index:0,delta,finish_reason}]});
const done='data: [DONE]\n\n';
const finish=res=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(chunk({content:'合成任务已处理'},'stop'))+done);};
async function fixture(t,responder){
  const root=await mkdtemp(join(tmpdir(),'reed-wire-contract-')),data=join(root,'data');await mkdir(data);
  const events=[],requests=[],waiters=new Set();let seq=0,child,stderr='';
  const server=createServer(async(req,res)=>{
    if(req.url==='/router/load'){res.writeHead(404);res.end();return;}
    const pieces=[];for await(const part of req)pieces.push(part);
    const payload=JSON.parse(Buffer.concat(pieces));requests.push(payload);
    try{await responder({req,res,payload,index:requests.length,root});}catch(e){res.destroy(e);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const provider={id:'wire-test',name:'synthetic',template:'custom',deployment:'local',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',enabled:true,contextWindow:65536,maxTokens:4096,reasoning:true,thinkingLevels:['off','medium'],compat:{thinkingFormat:'openai',supportsReasoningEffort:true}}]};
  await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},security:{approval:'auto'},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{skills:[],vaultPath:null,webEnabled:false,browserEnabled:false}}));
  await writeFile(join(data,'app-state.json'),JSON.stringify({provider:provider.id,modelId:'mock',projectPath:root}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',b=>stderr+=b);
  createInterface({input:child.stdout}).on('line',line=>{const e=JSON.parse(line);events.push(e);for(const w of [...waiters])if(w.p(e)){clearTimeout(w.timer);waiters.delete(w);w.resolve(e);}});
  const until=(p,ms=10000)=>{const found=events.find(p);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const w={p,resolve};w.timer=setTimeout(()=>{waiters.delete(w);reject(Error('missing event '+p+' '+stderr));},ms);waiters.add(w);});};
  const send=(type,args={})=>{const id=String(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');return id;};
  const command=async(type,args={})=>{const id=send(type,args);const e=await until(e=>e.id===id&&['ack','error','done'].includes(e.type));assert.notEqual(e.type,'error',e.message);return e;};
  t.after(async()=>{for(const w of waiters)clearTimeout(w.timer);child.kill();if(child.exitCode===null)await new Promise(r=>child.once('close',r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await until(e=>e.type==='ready');await command('init');
  return {root,data,events,requests,send,until,command,records:async()=>JSON.parse('['+(await readFile(join(data,'request-diagnostics.jsonl'),'utf8')).trim().split('\n').join(',')+']')};
}

test('bridge holds complete tool fragments until DONE/EOF, then executes exactly once and keeps result across recovery',{timeout:30000},async t=>{
  let release,contact;const gate=new Promise(r=>release=r),reached=new Promise(r=>contact=r);t.after(()=>release());
  const f=await fixture(t,async({res,index,root,payload})=>{
    if(index===1){res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame(chunk({tool_calls:[{index:0,id:'write-once',type:'function',function:{name:'write',arguments:JSON.stringify({path:join(root,'test-once.txt'),content:'合成一次'})}}]},'tool_calls')));contact();await gate;res.end(done);}
    else if(index===2){res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(chunk({reasoning_content:'PRIVATE_SYNTHETIC_REASONING'}))+frame({error:{code:'incomplete_response'},ninfer:{raw_finish_reason:'stop_token',response_status:'incomplete'}})+done);}
    else{assert.ok(payload.messages.some(m=>m.role==='tool'&&m.tool_call_id==='write-once'));finish(res);}
  });
  const id=f.send('prompt',{text:'test-合成写入一次，勿保存记忆'});await reached;
  await assert.rejects(readFile(join(f.root,'test-once.txt')),{code:'ENOENT'});
  release();const result=await f.until(e=>e.id===id&&e.type==='done');assert.equal(result.outcome.status,'complete');
  assert.equal(await readFile(join(f.root,'test-once.txt'),'utf8'),'合成一次');assert.equal(f.requests.length,3);
  assert.equal(f.events.filter(e=>e.type==='tool_start'&&e.name==='write').length,1);
  const records=await f.records();assert.equal(records.filter(e=>e.type==='tool_ledger'&&e.state==='completed').length,1);
  const wire=records.filter(e=>e.type==='model_wire'&&e.phase!=='cancel_requested');assert.equal(new Set(wire.map(e=>e.attempt_id)).size,3);
  assert.ok(wire.every(e=>e.sdkVersion.piAi==='1.1.0'));assert.ok(!JSON.stringify(records).includes('PRIVATE_SYNTHETIC_REASONING'));
});

for(const kind of ['length','missing_DONE','error_DONE','placeholder','raw_cancelled','HTTP502'])test(`bridge contract ${kind} cannot execute partial write`,{timeout:30000},async t=>{
  const f=await fixture(t,async({res,index,root})=>{
    if(index>1){finish(res);return;}
    if(kind==='HTTP502'){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'incomplete_response'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const tool={index:0,id:'partial-write',type:'function',function:{name:kind==='placeholder'?'malformed_tool_call':'write',arguments:JSON.stringify({path:join(root,'test-never.txt'),content:'不应执行',intended_function:'write'})}};
    let obj=chunk({tool_calls:[tool]},kind==='length'?'length':'tool_calls');
    if(kind==='length')obj.ninfer={raw_finish_reason:'output_limit',response_status:'limited'};
    if(kind==='raw_cancelled')obj.ninfer={raw_finish_reason:'cancelled',response_status:'cancelled'};
    res.write(frame(obj));if(kind==='error_DONE')res.write(frame({error:{code:'upstream_failure'}}));res.end(kind==='missing_DONE'?'':done);
  });
  const result=await f.command('prompt',{text:'test-协议失败不能写入'});
  await assert.rejects(readFile(join(f.root,'test-never.txt')),{code:'ENOENT'});
  assert.equal(f.events.filter(e=>e.type==='tool_start'&&e.name==='write').length,0);
  assert.equal(f.requests.length,kind==='raw_cancelled'?1:2,'统一最多一次恢复，raw取消零恢复');
  if(kind==='raw_cancelled')assert.equal(result.outcome.status,'aborted');
  const wire=(await f.records()).filter(e=>e.type==='model_wire')[0];
  assert.equal(wire.status,kind==='length'?'limited':kind==='raw_cancelled'?'cancelled':'incomplete');
  if(kind==='length')assert.equal(wire.finishReason,'length');
});

for(const repeated of [false,true])test(`bridge preserves partial text and bounds invalid read recovery (${repeated?'repeated':'recovered'})`,{timeout:30000},async t=>{
  const f=await fixture(t,async({res,index,root,payload})=>{
    if(index===1||repeated){res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(chunk({content:'合成的已有正文。\n'}))+frame(chunk({tool_calls:[{index:0,id:'invalid-read',type:'function',function:{name:'read',arguments:'{"path":'}}]},'tool_calls'))+done);return;}
    if(index===2){
      assert.ok(payload.messages.some(m=>JSON.stringify(m.content).includes('合成的已有正文')),'续接保留已显示正文');
      const note=join(root,'test-reference.md');await writeFile(note,'合成资料只读');
      res.writeHead(200,{'content-type':'text/event-stream'});res.end(frame(chunk({tool_calls:[{index:0,id:'valid-read',type:'function',function:{name:'read',arguments:JSON.stringify({path:note})}}]},'tool_calls'))+done);return;
    }
    assert.ok(payload.messages.some(m=>m.role==='tool'&&m.tool_call_id==='valid-read'));finish(res);
  });
  const result=await f.command('prompt',{text:'test-读取合成参考资料，不要写入或保存记忆'});
  assert.equal(f.requests.length,repeated?2:3);assert.equal(result.outcome.status,repeated?'error':'complete');
  assert.equal(f.events.filter(e=>e.type==='tool_start'&&e.name==='read').length,repeated?0:1);
  assert.equal(f.events.filter(e=>e.type==='recovery').length,1);
});
