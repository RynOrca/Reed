import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

for(const headers of [false,true])test(`foreground cancellation and settings while upstream stalls ${headers?'after':'before'} headers`,{timeout:20000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-turn-lifecycle-')),data=join(root,'data');
 let child,seq=0,calls=0,held,contact,closed;
 const reached=new Promise(r=>contact=r),disconnected=new Promise(r=>closed=r),seen=[],waiters=new Set();
 const server=createServer(async(req,res)=>{
  if(req.url==='/router/load'){res.writeHead(404);res.end();return;}
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'mock',context_window:65536,max_tokens:2048}]}));return;}
  for await(const _chunk of req){}calls++;
  if(calls===1){held=res;res.once('close',closed);if(headers){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();}contact();return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const part of [{delta:{role:'assistant',content:'收到'},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write(`data: ${JSON.stringify({id:'mock',choices:[{index:0,...part}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 const until=(predicate,ms=4000)=>{const prior=seen.find(predicate);if(prior)return Promise.resolve(prior);return new Promise((resolve,reject)=>{const waiter={predicate,resolve};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('missing event: '+predicate));},ms);waiters.add(waiter);});};
 const send=(type,args={})=>{const id=String(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');return id;};
 const command=async(type,args={})=>{const id=send(type,args),event=await until(e=>e.id===id&&['ack','error','done'].includes(e.type));assert.notEqual(event.type,'error',event.message);return event;};
 try{
  await mkdir(data);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const provider={id:'synthetic',template:'custom',deployment:'local',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',contextWindow:65536,maxTokens:2048,reasoning:false}]};
  await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
  await writeFile(join(data,'app-state.json'),JSON.stringify({provider:provider.id,modelId:'mock',projectPath:root}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.resume();
  createInterface({input:child.stdout}).on('line',line=>{const event=JSON.parse(line);seen.push(event);for(const w of [...waiters])if(w.predicate(event)){clearTimeout(w.timer);waiters.delete(w);w.resolve(event);}});
  await until(e=>e.type==='ready');await command('init');
  const prompt=send('prompt',{text:'hi'});await Promise.race([reached,new Promise((_,reject)=>setTimeout(()=>reject(Error('no upstream request')),4000).unref())]);
  const {id:providerId,...configuration}=provider;
  const started=Date.now();const saved=await command('save_provider',{...configuration,providerId,name:'updated'});
  assert.ok(Date.now()-started<3000,'save cannot wait for foreground turn');assert.match(saved.message,/已保存/);
  await command('discover_models',{providerId:provider.id});
  const selection={providerId:provider.id,modelId:'mock',reasoning:'off'};await command('save_vault_overview_config',selection);
  assert.deepEqual(JSON.parse(await readFile(join(data,'user-config.json'),'utf8')).vaultOverviewSelection,selection);
  await command('get_state');const stopIndex=seen.length;await command('abort');
  const done=await until(e=>e.id===prompt&&e.type==='done');assert.equal(done.outcome.status,'aborted');
  await Promise.race([disconnected,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream not cancelled')),2000).unref())]);
  assert.ok(seen.slice(stopIndex).some(e=>e.type==='session_sync'&&e.busy===false));
  await command('prompt',{text:'再次回复收到'});assert.equal(calls,2);assert.ok(seen.some(e=>e.type==='delta'&&e.text==='收到'));
  await command('update_model',{providerId:provider.id,model:{id:'mock',enabled:false}});
  assert.ok(!seen.filter(e=>e.type==='models').at(-1).models.some(m=>m.provider===provider.id&&m.id==='mock'));
  await command('init'); // Disabled persisted selection must not break reinitialization.
  await command('update_model',{providerId:provider.id,model:{id:'mock',enabled:true}});
  await command('select_model',{provider:provider.id,model:'mock',thinkingLevel:'off'});
  assert.equal(calls,2,'configuration changes do not secretly generate a response');
 }finally{
  for(const w of waiters)clearTimeout(w.timer);held?.destroy();child?.stdin.end();child?.kill();if(child&&child.exitCode===null)await new Promise(r=>child.once('close',r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
