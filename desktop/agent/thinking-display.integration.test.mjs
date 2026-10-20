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
for(const field of ['reasoning_content','reasoning_text','reasoning','off'])test(field==='off'?'思考关闭不隐式开启，也不伪造思考记录':`实际服务思考字段 ${field} 经Bridge实时转发并保留历史`,{timeout:25000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-model-slots-')),data=join(root,'profile'),vault=join(root,'vault');let child,seq=0,active=0,peak=0;const requests=[],seen=[],waiters=new Set();const parallel=false;
 const finish=res=>{if(res.destroyed)return;res.write(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',...(field==='off'?{}:{[field]:'合成思考：先确认导航目标。'})},finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'隔离模型回复'},finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);};
 const server=createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(404);res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));requests.push(input);active++;peak=Math.max(peak,active);res.on('close',()=>active--);res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
  finish(res);
 });
 const until=(predicate,ms=12000)=>{const prior=seen.find(predicate);if(prior)return Promise.resolve(prior);return new Promise((resolve,reject)=>{const item={predicate,resolve};item.timer=setTimeout(()=>{waiters.delete(item);reject(Error('fixture event timeout'));},ms);waiters.add(item);});};
 const send=(type,args={})=>{const id=String(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');return id;};
 const command=async(type,args={})=>{const id=send(type,args);const result=await until(e=>e.id===id&&['ack','done','error'].includes(e.type));if(result.type==='error')throw Error(result.message);return result;};
 try{
  await Promise.all([mkdir(data),mkdir(vault)]);await writeFile(join(vault,'synthetic.md'),'# 隔离笔记\n只有合成内容。');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const provider={id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',parallelRequests:parallel,maxConcurrentRequests:2,models:[{id:'mock',contextWindow:65536,maxTokens:2048,reasoning:true,compat:{thinkingFormat:'openai',supportsReasoningEffort:true}}]};
  await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));await writeFile(join(data,'app-state.json'),JSON.stringify({provider:provider.id,modelId:'mock',projectPath:root}));
  child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.resume();
  createInterface({input:child.stdout}).on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}seen.push(event);for(const item of [...waiters])if(item.predicate(event)){waiters.delete(item);clearTimeout(item.timer);item.resolve(event);}});
  await until(e=>e.type==='ready');await command('init');await command('set_thinking_level',{level:field==='off'?'off':'medium'});
  await command('prompt',{text:'合成验证：只回复收到。'});
  assert.equal(requests.at(-1).reasoning_effort,field==='off'?undefined:'medium','实际请求须匹配思考档位');
  assert.equal(seen.some(e=>e.type==='delta'&&e.kind==='thinking'&&e.text.includes('先确认导航目标')),field!=='off','思考流应匹配服务实际返回');
  await command('get_history');
  assert.equal(seen.filter(e=>e.type==='history').at(-1).messages.some(m=>m.content?.some?.(b=>b.type==='thinking'&&(b.thinking||b.text||'').includes('先确认导航目标'))),field!=='off','历史思考应匹配实际内容');
 }finally{
  for(const item of waiters)clearTimeout(item.timer);child?.stdin.end();if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));await Promise.race([exited,delay(1500)]);if(child.exitCode===null){child.kill();await exited;}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
