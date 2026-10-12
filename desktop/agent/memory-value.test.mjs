import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryValueGate } from './memory-value.mjs';
import { createMemoryAgent, sessionDisallowsMemory } from './memory-agent.mjs';
import { MemoryStore } from './memory.mjs';
import { LearnerStore, learnerExtension } from './learner.mjs';
import { workMemoryExtension } from './work-memory.mjs';

const decision = (id, extra={})=>({id,supported:true,durable:true,useful:true,requested:false,confidence:0.95,...extra});
function fixture() {
  const session={sessionId:'isolated',model:{provider:'test'},state:{messages:[{role:'user',content:'记住我的长期目标：学习操作系统'}]}};
  let current=session, learning=true, work=true, output, stopReason='stop', calls=0;
  const gate=createMemoryValueGate({currentSession:()=>current,learningEnabled:()=>learning,workEnabled:()=>work,runtime:async()=>({completeSimple:async (_model,context,options)=>{
    calls++;assert.equal(options.reasoning,'off');assert.match(context.systemPrompt,/一次提问不表示不会/);
    const data=JSON.parse(context.messages[0].content[0].text);
    return {stopReason,content:[{type:'text',text:typeof output==='function'?await output(data):output??JSON.stringify({decisions:data.candidates.map(c=>decision(c.id))})}]};
  }})});
  return {session,gate,setOutput:value=>output=value,setStop:value=>stopReason=value,setLearning:value=>learning=value,setWork:value=>work=value,setSession:value=>current=value,get calls(){return calls;}};
}

test('价值审查逐项拒绝低价值、无证据和不确定候选；显式记住可覆盖短期性',async()=>{
  const f=fixture();
  f.setOutput(JSON.stringify({decisions:[decision(0,{durable:false}),decision(1,{useful:false}),decision(2,{supported:false}),decision(3,{confidence:0.5}),decision(4,{requested:true,durable:false,useful:false}),decision(5)]}));
  assert.deepEqual(await f.gate(Array.from({length:6},()=>({area:'profile',content:'candidate'}))),[false,false,false,false,true,true]);
  assert.equal(f.calls,1,'后台候选只发一次批量价值请求');
});

test('无效响应、重复索引、截断、模型失败和未配置模型都不能批准',async()=>{
  const f=fixture();
  for(const output of ['not json','{}',JSON.stringify({decisions:[decision(9)]}),JSON.stringify({decisions:[decision(0),decision(0)]}),JSON.stringify({decisions:[decision(0,{confidence:'1'})]})]){
    f.setOutput(output);assert.deepEqual(await f.gate([{content:'x'}]),[false]);
  }
  f.setOutput(undefined);f.setStop('length');assert.deepEqual(await f.gate([{content:'x'}]),[false]);
  f.setStop('stop');f.setOutput(()=>{throw Error('offline');});assert.deepEqual(await f.gate([{content:'x'}]),[false]);
  f.session.model.provider='unknown';assert.deepEqual(await f.gate([{content:'x'}]),[false]);
});

test('画像关闭仍能审查工作经验，禁写、新轮次、会话切换与取消使批准失效',async()=>{
  const f=fixture();f.setLearning(false);
  assert.deepEqual(await f.gate([{content:'learning'}]),[false]);assert.equal(f.calls,0);
  assert.deepEqual(await f.gate([{content:'verified shell'}],{work:true}),[true]);
  f.setWork(false);assert.deepEqual(await f.gate([{content:'shell'}],{work:true}),[false]);f.setWork(true);
  const controller=new AbortController();controller.abort();assert.deepEqual(await f.gate([{content:'shell'}],{work:true,signal:controller.signal}),[false]);
  f.setOutput(data=>{f.session.state.messages.push({role:'user',content:'continue'});return JSON.stringify({decisions:data.candidates.map(c=>decision(c.id))});});
  assert.deepEqual(await f.gate([{content:'shell'}],{work:true}),[false]);
  f.setOutput(data=>{f.setSession({...f.session});return JSON.stringify({decisions:data.candidates.map(c=>decision(c.id))});});
  assert.deepEqual(await f.gate([{content:'shell'}],{work:true}),[false]);f.setSession(f.session);
  f.session.state.messages.push({role:'user',content:'别记这个'});assert.equal(sessionDisallowsMemory(f.session),true);
  assert.deepEqual(await f.gate([{content:'shell'}],{work:true}),[false]);
});

test('真实隔离存储：即时工具和后台均先审查再合并，跳过不落盘',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-memory-value-'));
  try {
    const memory=new MemoryStore(root,root),learner=new LearnerStore(root),f=fixture(),tools={},events={};
    await memory.load();await learner.load();let matching=0;
    memory.matchTopic=learner.matchTopic=memory.matchWorkTopic=async()=>{matching++;return null;};
    const register={registerTool:t=>tools[t.name]=t,on:(name,fn)=>events[name]=fn};
    const candidate={kind:'goal',subject:'操作系统',detail:'长期学习操作系统',evidence:'学习操作系统'};
    const agent=createMemoryAgent({memory,learner,judgeValue:f.gate,currentSession:()=>f.session,send(){},runtime:async()=>({completeSimple:async()=>({content:[{type:'text',text:JSON.stringify({facts:[{key:'普通问题',content:'问了一个问题'}],notes:[{title:'助手讲解',body:'今天的答案'}],learningEvents:[candidate]})}]})})});
    agent.extension(register);learnerExtension({memory,learner,judgeValue:f.gate,currentSession:()=>f.session,send(){}})(register);
    workMemoryExtension({memory,learner,judgeValue:f.gate,currentSession:()=>f.session,roles:{current:()=>({learnerProfileEnabled:true})},reviewEnabled:()=>false,send(){}})(register);
    f.setOutput(data=>JSON.stringify({decisions:data.candidates.map(c=>decision(c.id,{useful:false,requested:false}))}));
    assert.equal((await tools.remember.execute('1',{layer:'profile',key:'临时任务',content:'今天做题'})).details.skipped,true);
    assert.equal((await tools.record_learning_event.execute('2',candidate)).details.skipped,true);
    events.before_agent_start();events.tool_result({toolName:'read',input:{path:'C:/Temp/test.md'},isError:false});
    assert.equal((await tools.remember_work.execute('3',{kind:'path',title:'临时文件',body:'C:/Temp/test.md',evidence:'C:/Temp/test.md'})).details.skipped,true);
    await agent.consolidate();assert.equal(matching,0);assert.equal(memory.snapshot().facts.length,0);assert.equal(memory.snapshot().notes.length,0);assert.equal(memory.snapshot().working.length,0);assert.equal(learner.snapshot().eventCount,0);
    const reloaded=new MemoryStore(root,root);await reloaded.load();assert.equal(reloaded.snapshot().facts.length,0);
    f.setOutput(data=>{controller.abort();return JSON.stringify({decisions:data.candidates.map(c=>decision(c.id))});});
    const controller=new AbortController();
    assert.equal((await tools.remember.execute('cancel',{layer:'profile',key:'长期目标',content:'学习操作系统'},controller.signal)).details.skipped,true);
    assert.equal(memory.snapshot().facts.length,0,'用户中途停止不能继续保存');
    f.setOutput(undefined);await tools.remember.execute('4',{layer:'profile',key:'长期目标',content:'学习操作系统'});await tools.record_learning_event.execute('5',candidate);
    assert.equal(memory.snapshot().facts.length,1);assert.equal(learner.snapshot().eventCount,1);assert.equal(matching,2);
    agent.cancel();
  }finally {await rm(root,{recursive:true,force:true});}
});
