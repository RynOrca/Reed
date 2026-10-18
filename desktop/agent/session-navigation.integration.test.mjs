import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('navigation and queued turns preserve the running session context and events', {timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'reed-session-navigation-'));
  const data=join(root,'profile'),project=join(root,'test-project');await mkdir(project);await mkdir(data);
  const events=[],requests=[];let release,releaseDelete,sequence=0,stderr='';const held=new Promise(resolve=>release=resolve),heldDelete=new Promise(resolve=>releaseDelete=resolve);
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'navigation-model',context_length:65536,supports_reasoning:true,reasoning_efforts:['off','medium']}]}));return;}
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({active_requests:0}));return;}
    const chunks=[];for await(const c of req)chunks.push(c);const payload=JSON.parse(Buffer.concat(chunks));requests.push(payload);
    const users=payload.messages.filter(m=>m.role==='user').map(m=>JSON.stringify(m.content)).join('\n');
    res.setHeader('content-type','text/event-stream');
    const frame=(delta,finish_reason=null)=>`data: ${JSON.stringify({id:'test',model:'navigation-model',choices:[{index:0,delta,finish_reason}]})}\n\n`;
    if(users.includes('TASK_LOOP')){
      res.write(frame({tool_calls:[{index:0,id:`loop-read-${requests.length}`,type:'function',function:{name:'read',arguments:JSON.stringify({path:join(project,'test-output.txt'),offset:1,limit:30})}}]}));res.end(frame({},'tool_calls')+'data: [DONE]\n\n');return;
    }
    if(users.includes('TASK_A')){res.write(frame({reasoning_content:'SYNTHETIC_A_THINKING'}));await held;}
    if(users.includes('TASK_DELETE')){res.write(frame({reasoning_content:'SYNTHETIC_DELETE_THINKING'}));res.once('close',releaseDelete);await heldDelete;}
    if(users.includes('TASK_A')&&payload.messages.at(-1)?.role!=='tool'){
      res.write(frame({tool_calls:[{index:0,id:'synthetic-write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'test-output.txt',content:'isolated A output'})}}]}));res.end(frame({},'tool_calls')+'data: [DONE]\n\n');return;
    }
    res.write(frame({content:users.includes('TASK_A')?'A_FINISHED':'B_FINISHED'}));res.end(frame({},'stop')+'data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',chunk=>stderr+=chunk);
  createInterface({input:child.stdout}).on('line',line=>events.push(JSON.parse(line)));
  t.after(async()=>{release();releaseDelete();if(child.exitCode===null){const closed=once(child,'close');child.kill();await closed;}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const until=async(predicate)=>{const end=Date.now()+20000;while(Date.now()<end){const found=events.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(`Timeout: ${stderr}; ${JSON.stringify(events.slice(-4))}`);};
  let viewing;
  const command=(type,args={})=>{const id=`nav-${++sequence}`;child.stdin.write(JSON.stringify({type,id,sessionId:viewing,...args})+'\n');return until(e=>e.id===id&&['ack','done','error','sessions'].includes(e.type)).then(e=>{assert.notEqual(e.type,'error',e.message);return e;});};
  await until(e=>e.type==='ready');await command('init');viewing=events.findLast(e=>e.type==='session').sessionId;
  for(const layer of ['l1','l2','l3','work'])await command('memory_enabled',{layer,enabled:false});
  const provider=await command('save_provider',{template:'custom',name:'navigation-test',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions'});
  await command('discover_models',{providerId:provider.providerId});await command('update_model',{providerId:provider.providerId,model:{id:'navigation-model',enabled:true}});
  await command('select_model',{provider:provider.providerId,model:'navigation-model',thinkingLevel:'medium'});
  await command('set_approval',{mode:'auto'});
  await command('select_role',{roleId:'quick'});viewing=events.findLast(e=>e.type==='session').sessionId;
  await command('change_workspace',{path:project});const a=events.findLast(e=>e.type==='session');viewing=a.sessionId;
  const taskA=command('prompt',{text:'TASK_A 不要写入记忆'});
  await until(e=>e.type==='delta'&&e.text==='SYNTHETIC_A_THINKING');
  await command('new_session');const b=events.findLast(e=>e.type==='session');viewing=b.sessionId;
  assert.equal(b.workspace,project);assert.equal(b.roleId,'quick');assert.notEqual(a.sessionId,b.sessionId);
  await command('new_session');const disposable=events.findLast(e=>e.type==='session').sessionId;viewing=disposable;
  await command('open_session',{sessionId:b.sessionId});viewing=b.sessionId;
  await command('delete_session',{sessionId:disposable,confirm:true});
  assert.ok(!(await command('list_sessions')).sessions.some(s=>s.id===disposable));
  await command('open_session',{sessionId:a.sessionId});viewing=a.sessionId;
  const live=events.findLast(e=>e.type==='history'&&e.sessionId===a.sessionId);
  assert.ok(live.replay.some(e=>e.type==='delta'&&e.text==='SYNTHETIC_A_THINKING'));
  assert.equal(live.replay.filter(e=>e.type==='restore_user').length,1);
  await command('open_session',{sessionId:b.sessionId});viewing=b.sessionId;
  const taskB=command('prompt',{text:'TASK_B 不要写入记忆'});
  await until(e=>e.type==='started'&&e.queued&&e.sessionId===b.sessionId);
  assert.equal(requests.length,1,'B waits while A retains its execution context');
  await command('abort');await taskB;
  assert.ok(!events.some(e=>e.type==='done'&&e.sessionId===a.sessionId));
  const secondB=command('prompt',{text:'TASK_B 不要写入记忆'});
  release();const doneA=await taskA,doneB=await secondB;
  assert.equal(doneA.sessionId,a.sessionId);assert.equal(doneB.sessionId,b.sessionId);
  assert.equal(doneA.outcome.status,'complete');assert.equal(doneB.outcome.status,'complete');
  assert.equal(requests.length,3);
  assert.ok(requests[1].messages.some(m=>m.role==='tool'&&JSON.stringify(m).includes('test-output.txt')),'actual tool result must reach the next model request');
  assert.ok(!JSON.stringify(requests[2].messages).includes('TASK_A'),'B must not inherit A transcript');
  assert.equal(requests[2].reasoning_effort,'medium');
  assert.equal(await readFile(join(project,'test-output.txt'),'utf8'),'isolated A output');
  const sessions=(await command('list_sessions')).sessions;
  const savedA=sessions.find(s=>s.id===a.sessionId);
  const history=await readFile(savedA.path,'utf8');assert.ok(history.includes('reed_turn_timing'));
  await command('new_session',{noProject:true});const defaultView=events.findLast(e=>e.type==='session');
  assert.equal(defaultView.workspace,null);assert.equal(defaultView.roleId,'quick');assert.equal(defaultView.defaultWorkspace,join(data,'workspace'));
  viewing=defaultView.sessionId;
  const deleteTurn=command('prompt',{text:'TASK_DELETE 不要写入记忆'});
  await until(e=>e.type==='delta'&&e.text==='SYNTHETIC_DELETE_THINKING');
  await command('delete_session',{sessionId:viewing,confirm:true});
  assert.equal((await deleteTurn).outcome.status,'aborted');
  assert.ok(!(await command('list_sessions')).sessions.some(s=>s.id===defaultView.sessionId));
  viewing=events.findLast(e=>e.type==='session').sessionId;
  const beforeLoop=requests.length;
  const loop=await command('prompt',{text:'TASK_LOOP 不要写入记忆'});
  assert.equal(loop.outcome.code,'task_no_progress');
  assert.ok(requests.length-beforeLoop<=10,'unchanged read loop must stop instead of running indefinitely');
  assert.ok(requests.slice(beforeLoop).some(r=>r.messages.some(m=>m.role==='tool'&&JSON.stringify(m).includes('执行监测'))),'correction must reach the model through real tool results');
  await command('get_history');const loopHistory=events.findLast(e=>e.type==='history');
  assert.ok(loopHistory.messages.some(m=>m.outcome?.code==='task_no_progress'),'history must retain the terminal failure, not claim success');
});
