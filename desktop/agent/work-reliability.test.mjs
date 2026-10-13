import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from './memory.mjs';
import {workMemoryExtension} from './work-memory.mjs';
import {roleFeatureExtension} from './role-features.mjs';
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'reed-work-reliability-'));try{await mkdir(join(root,'sessions'));await fn(root,new MemoryStore(root,join(root,'sessions')));}finally{await rm(root,{recursive:true,force:true});}};

test('工作经验自动整理独立于画像，同主题补充，重启可读取并按错误召回',()=>fixture(async(root,memory)=>{
  const session={sessionId:'s',model:{provider:'test',id:'work'},state:{messages:[{role:'user',content:'处理文件'}]}};let body='Bash Unexpected token：用单引号包裹参数，验证成功。';const events={};
  const extension=workMemoryExtension({memory,learner:{},roles:{current:()=>({learnerProfileEnabled:false})},currentSession:()=>session,reviewEnabled:()=>false,send(){},judgeValue:async cs=>cs.map(()=>true),runtime:async()=>({completeSimple:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({items:[{kind:'shell',title:'Bash 参数引号',body,evidence:'Command succeeded'}]})}]})})});
  extension({registerTool(){},on:(n,f)=>events[n]=f});events.before_agent_start();events.tool_result({toolName:'mcp_call',input:{command:'bash script'},isError:true,content:[{type:'text',text:'Unexpected token'}]});events.tool_result({toolName:'mcp_call',input:{command:'bash corrected'},content:[{type:'text',text:'Command succeeded'}]});
  await extension.consolidate();assert.equal(memory.state.working.length,1);
  body='Bash 参数含空格时也要加引号，Command succeeded。';await extension.consolidate();assert.equal(memory.state.working.length,1);assert.match(memory.state.working[0].body,/Unexpected token[\s\S]*含空格/);
  const loaded=new MemoryStore(root,join(root,'sessions'));await loaded.load();assert.match(loaded.workContext('Bash Unexpected token'),/单引号/);
  const hooks={};roleFeatureExtension({memory:loaded,roles:{current:()=>({})},goals:{section:async()=>null},project:()=>root,learner:{},currentSession:()=>session})({on:(n,f)=>hooks[n]=f});
  const reply=await hooks.context_with_system({messages:[{role:'system'},{role:'user',content:'继续处理'},{role:'toolResult',content:[{type:'text',text:'Bash Unexpected token'}]}]});assert.match(reply.messages.at(-1).sections.summon_work,/单引号/);
}));

test('相同标题但不同 Shell、路径或项目不能误合并',()=>fixture(async(_root,memory)=>{
  for(const body of ['Bash 使用单引号','PowerShell 使用反引号'])await memory.rememberWork({kind:'shell',title:'参数转义',body},'s');
  for(const body of ['目录 C:\\project-a','目录 C:\\project-b'])await memory.rememberWork({kind:'path',title:'常用目录',body},'s');
  for(const scope of ['project-a','project-b'])await memory.rememberWork({kind:'workflow',title:'构建流程',body:'执行构建',scope},'s');
  assert.equal(memory.state.working.length,6);
  assert.equal(memory.workItems('project-a').filter(i=>i.kind==='workflow').length,1);
  assert.equal(memory.workItems('project-b').filter(i=>i.kind==='workflow').length,1);
  assert.equal(memory.workItems('project-c').filter(i=>i.kind==='workflow').length,0);
  assert.doesNotMatch(memory.workContext('构建','project-c'),/构建流程/);
  await assert.rejects(memory.deleteWork('构建流程'),/同名/);
  const target=memory.workItems('project-a').find(i=>i.kind==='workflow');await memory.deleteWork(undefined,target.id);
  assert.equal(memory.workItems('project-b').filter(i=>i.kind==='workflow').length,1);assert.equal(memory.state.working.length,5);
}));

test('无成功工具证据或新轮次到来时不保存后台经验',()=>fixture(async(_root,memory)=>{
  const session={sessionId:'s',model:{provider:'test',id:'work'},state:{messages:[]}},events={};let release,calls=0;
  const extension=workMemoryExtension({memory,learner:{},roles:{current:()=>({})},currentSession:()=>session,reviewEnabled:()=>false,send(){},judgeValue:async cs=>cs.map(()=>true),runtime:async()=>({completeSimple:async()=>{calls++;return new Promise(r=>release=r);}})});
  extension({registerTool(){},on:(n,f)=>events[n]=f});events.before_agent_start();events.tool_result({toolName:'mcp_call',isError:true,content:[]});await extension.consolidate();assert.equal(calls,0);
  events.tool_result({toolName:'mcp_call',content:[{type:'text',text:'Command succeeded'}]});const pending=extension.consolidate();while(!release)await new Promise(r=>setTimeout(r,5));session.state.messages.push({role:'user',content:'新问题'});release({stopReason:'stop',content:[{type:'text',text:'{"items":[]}'}]});await pending;assert.equal(memory.state.working.length,0);
}));
