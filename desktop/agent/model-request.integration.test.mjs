import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const parallel of [false,true])test(`real bridge uses unified model slots: ${parallel?'experimental parallel':'serial and queued cancellation'}`,{timeout:25000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-model-slots-')),data=join(root,'profile'),vault=join(root,'vault');let child,seq=0,active=0,peak=0;const requests=[],seen=[],waiters=new Set();let releaseFirst;
 const finish=res=>{if(res.destroyed)return;res.write(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'# 隔离模型回复'},finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);};
 const server=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));requests.push(input);active++;peak=Math.max(peak,active);res.on('close',()=>active--);res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  if(requests.length===1)releaseFirst=()=>finish(res);else finish(res);
 });
 const until=(predicate,ms=12000)=>{const prior=seen.find(predicate);if(prior)return Promise.resolve(prior);return new Promise((resolve,reject)=>{const item={predicate,resolve};item.timer=setTimeout(()=>{waiters.delete(item);reject(Error('fixture event timeout'));},ms);waiters.add(item);});};
 const send=(type,args={})=>{const id=String(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');return id;};
 const command=async(type,args={})=>{const id=send(type,args);const result=await until(e=>e.id===id&&['ack','done','error'].includes(e.type));if(result.type==='error')throw Error(result.message);return result;};
 try{
  await Promise.all([mkdir(data),mkdir(vault)]);await writeFile(join(vault,'synthetic.md'),'# 隔离笔记\n只有合成内容。');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const provider={id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',parallelRequests:parallel,maxConcurrentRequests:2,models:[{id:'mock',contextWindow:65536,maxTokens:2048,reasoning:false}]};
  await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));await writeFile(join(data,'app-state.json'),JSON.stringify({provider:provider.id,modelId:'mock',projectPath:root}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.resume();
  createInterface({input:child.stdout}).on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}seen.push(event);for(const item of [...waiters])if(item.predicate(event)){waiters.delete(item);clearTimeout(item.timer);item.resolve(event);}});
  await until(e=>e.type==='ready');await command('init');await command('configure_capabilities',{vaultPath:vault});await command('generate_vault_overview');
  for(let i=0;i<100&&!releaseFirst;i++)await delay(20);assert.ok(releaseFirst,'overview must reach mock service first');
  const promptId=send('prompt',{text:'只回复收到，不调用工具或保存记忆。'});
  if(parallel){await until(e=>e.type==='done'&&e.id===promptId);assert.equal(peak,2);assert.equal(requests.length,2);}
  else{
   await until(e=>e.type==='model_queue'&&e.state==='waiting');assert.equal(requests.length,1);await command('abort');await until(e=>e.id===promptId&&['done','error'].includes(e.type));assert.equal(requests.length,1,'cancelled queued prompt must not contact service');
  }
  releaseFirst();await until(e=>e.type==='vault_overview'&&e.state==='ready');
  await command('prompt',{text:'再次回复收到，不使用工具或保存记忆。'});assert.equal(peak,parallel?2:1);assert.ok(seen.some(e=>e.type==='delta'&&e.text.includes('隔离模型回复')));
 }finally{
  for(const item of waiters)clearTimeout(item.timer);child?.stdin.end();if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));await Promise.race([exited,delay(1500)]);if(child.exitCode===null){child.kill();await exited;}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
