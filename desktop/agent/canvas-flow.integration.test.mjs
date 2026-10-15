import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('真实 bridge 画布：打开整理、显式引用追问、布局保存、关闭停整理、归档保留与确认删除', {timeout:30000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-canvas-flow-')),data=join(root,'data'),seen=[],waiters=new Set();let child,seq=0,analysisCalls=0,referenceSeen=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),system=JSON.stringify(body.messages.filter(m=>['system','developer'].includes(m.role)));
    let answer='这是可追溯的切块说明。';
    if(system.includes('对话画布整理器')){analysisCalls++;const last=body.messages.findLast(m=>m.role==='user');const input=JSON.parse(typeof last.content==='string'?last.content:last.content.map(b=>b.text||'').join(''));answer=JSON.stringify({nodes:input.turns.map(turn=>({id:turn.id,title:turn.question.slice(0,60),summary:'切块应保留完整依据。',relations:[]}))});}
    else if(system.includes('用户本轮明确引用的同会话问答'))referenceSeen=true;
    res.writeHead(200,{'content-type':'text/event-stream'});for(const part of [{delta:{role:'assistant',content:answer},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write(`data: ${JSON.stringify({id:'mock',choices:[{index:0,...part}]})}\n\n`);res.end('data: [DONE]\n\n');
  });
  const until=(predicate,from=0)=>{const found=seen.slice(from).find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('missing canvas event'));},7000);waiters.add(waiter);});};
  const command=async(type,args={})=>{const id=`canvas-${++seq}`;child.stdin.write(JSON.stringify({id,type,...args})+'\n');const response=await until(e=>e.id===id&&['ack','error','done'].includes(e.type));if(response.type==='error')throw Error(response.message);return response;};
  try{
    await mkdir(data);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const provider={id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',contextWindow:65536,maxTokens:4096,reasoning:false}]};
    await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},roles:{activeId:'agent',roles:[{id:'agent',name:'导师',system:'隔离测试',learningModeEnabled:true,canvasEnabled:true}]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
    await writeFile(join(data,'app-state.json'),JSON.stringify({provider:'synthetic',modelId:'mock',projectPath:root}));
    child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.resume();
    createInterface({input:child.stdout}).on('line',line=>{const event=JSON.parse(line);seen.push(event);for(const waiter of [...waiters])if(waiter.predicate(event)){clearTimeout(waiter.timer);waiters.delete(waiter);waiter.resolve(event);}});
    await until(e=>e.type==='ready');await command('init');
    await command('save_role',{name:'自定义学习助手',system:'保留角色说明'});const roleId=seen.findLast(e=>e.type==='roles').roles.find(r=>r.name==='自定义学习助手').id;
    await command('select_role',{roleId});await command('set_role_learning',{roleId,learningModeEnabled:true,canvasEnabled:true});
    const roleSaved=JSON.parse(await readFile(join(data,'user-config.json'),'utf8')).roles.roles.find(r=>r.id===roleId);assert.equal(roleSaved.canvasEnabled,true);assert.equal(roleSaved.system,'保留角色说明');assert.equal(seen.findLast(e=>e.type==='session').canvasEnabled,true);
    const sessionId=seen.findLast(e=>e.type==='session').sessionId;
    await command('prompt',{text:'为什么要切块？'});assert.equal(analysisCalls,0);
    const opened=await command('canvas_open',{sessionId});assert.equal(opened.graph.nodes.length,1);const nodeId=opened.graph.nodes[0].id;
    await until(e=>e.type==='canvas'&&e.state==='ready'&&e.graph.nodes[0]?.state==='ready');
    const source=(await command('canvas_source',{sessionId,nodeId})).source;assert.equal(source.question,'为什么要切块？');assert.match(source.answer,/可追溯/);
    const index=seen.length;await command('prompt',{text:'能举个例子吗？',canvasSessionId:sessionId,canvasNodeId:nodeId});
    const updated=await until(e=>e.type==='canvas'&&e.state==='ready'&&e.graph.nodes.length===2&&e.graph.nodes.every(n=>n.state==='ready'),index);
    assert.equal(referenceSeen,true);assert.equal(updated.graph.edges[0].explicit,true);assert.equal(updated.graph.edges[0].from,nodeId);
    await command('canvas_edit',{sessionId,patch:{nodes:[{id:nodeId,x:400,y:500,title:'我的问题'}],view:{x:30,y:40,scale:.9}}});
    const saved=JSON.parse(await readFile(join(data,'canvases',sessionId+'.json'),'utf8'));assert.equal(saved.nodes[0].x,400);assert.equal(saved.nodes[0].title,'我的问题');
    await assert.rejects(command('canvas_source',{sessionId:'other',nodeId}),/会话已切换/);
    await command('canvas_close',{sessionId});const calls=analysisCalls;await command('prompt',{text:'再比较一下'});assert.equal(analysisCalls,calls);
    await command('archive_session',{sessionId});await access(join(data,'canvases',sessionId+'.json'));
    await assert.rejects(command('delete_session',{sessionId}),/确认/);await access(join(data,'canvases',sessionId+'.json'));
    await command('delete_session',{sessionId,confirm:true});await assert.rejects(access(join(data,'canvases',sessionId+'.json')),/ENOENT/);
  }finally{for(const waiter of waiters)clearTimeout(waiter.timer);if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
