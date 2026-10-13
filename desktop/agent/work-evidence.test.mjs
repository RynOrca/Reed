import test from 'node:test';
import assert from 'node:assert/strict';
import {workMemoryExtension} from './work-memory.mjs';

test('真实嵌套JSON输出可逐字引用；拼接说明仍拒绝并给出原文纠正提示',async()=>{
  const events={},tools={},saved=[];
  const session={sessionId:'s',state:{messages:[{role:'user',content:'修正并记住'}]}};
  const memory={state:{enabled:{work:true}},rememberWork:async input=>{saved.push(input);return {id:'verified',operation:'create'};},snapshot:()=>({})};
  workMemoryExtension({memory,roles:{current:()=>({})},currentSession:()=>session,reviewEnabled:()=>false,send(){},judgeValue:async c=>c.map(()=>true)})({on:(n,f)=>events[n]=f,registerTool:t=>tools[t.name]=t});
  events.before_agent_start();events.tool_result({toolName:'mcp_call',input:{arguments:{command:"Write-Output 'amber'; Write-Output 'violet'"}},content:[{type:'text',text:JSON.stringify({exitCode:0,stdout:'amber\r\nviolet'})}]});
  const input={kind:'shell',title:'PowerShell 串联',body:'用分号执行两段命令',evidence:'第一次报错；第二次输出 amber 和 violet'};
  await assert.rejects(tools.remember_work.execute('1',input),/不能拼接[\s\S]*amber/);
  await assert.rejects(tools.remember_work.execute('2',{...input,evidence:'另一段拼接证据'}),/未保存/);assert.equal(events.tool_call({toolName:'remember_work',input}).terminate,true);
  await assert.rejects(tools.remember_work.execute('3',{...input,evidence:'amber\r\nviolet'}),/已停止/);
  session.state.messages.push({role:'user',content:'新的保存任务'});events.before_agent_start();events.tool_result({toolName:'mcp_call',input:{arguments:{command:"Write-Output 'amber'; Write-Output 'violet'"}},content:[{type:'text',text:JSON.stringify({exitCode:0,stdout:'amber\r\nviolet'})}]});
  const accepted=await tools.remember_work.execute('3',{...input,evidence:'amber\r\nviolet'});assert.equal(accepted.details.receipt.id,'verified');assert.equal(saved.length,1);
  session.state.messages.push({role:'user',content:'新的任务'});assert.equal(events.tool_call({toolName:'remember_work',input}),undefined);
  for(let i=0;i<4;i++)await assert.rejects(tools.remember_work.execute('rename-'+i,{...input,title:'不同标题'+i}),/未保存/);
  assert.equal(events.tool_call({toolName:'remember_work',input:{...input,title:'又改标题'}}).terminate,true);
});
