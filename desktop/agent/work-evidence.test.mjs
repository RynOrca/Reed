import test from 'node:test';
import assert from 'node:assert/strict';
import {workMemoryExtension} from './work-memory.mjs';

test('真实嵌套JSON输出可逐字引用；拼接说明仍拒绝并给出原文纠正提示',async()=>{
  const events={},tools={},saved=[],reviews=[];
  let backgroundCalls=0;
  const session={model:{provider:'test',id:'work'},sessionId:'s',state:{messages:[{role:'user',content:'修正并记住'}]}};
  const memory={state:{enabled:{work:true}},rememberWork:async input=>{saved.push(input);return {id:'verified',operation:'create'};},snapshot:()=>({})};
  const extension=workMemoryExtension({runtime:async()=>{backgroundCalls++;throw Error('background test');},memory,roles:{current:()=>({})},currentSession:()=>session,reviewEnabled:()=>false,send(){},judgeValue:async(c,options)=>{reviews.push(options.evidence);return c.map(()=>true);}});extension({on:(n,f)=>events[n]=f,registerTool:t=>tools[t.name]=t});
  events.before_agent_start();events.tool_result({toolName:'mcp_discover',content:[{type:'text',text:'AVAILABLE_TOOL_SCHEMA_SENTINEL'}]});events.tool_result({toolName:'mcp_call',input:{arguments:{command:'broken'}},isError:true,content:[{type:'text',text:'Parser error'}]});events.tool_result({toolName:'mcp_call',input:{arguments:{command:"Write-Output 'amber'; Write-Output 'violet'"}},content:[{type:'text',text:JSON.stringify({exitCode:0,stdout:'amber\r\nviolet'})}]});
  const input={kind:'shell',title:'PowerShell 串联',body:'用分号执行两段命令',evidence:'第一次报错；第二次输出 amber 和 violet'};
  await assert.rejects(tools.remember_work.execute('1',input),/不能拼接[\s\S]*amber/);
  await assert.rejects(tools.remember_work.execute('2',{...input,evidence:'另一段拼接证据'}),/未保存/);assert.equal(events.tool_call({toolName:'remember_work',input}).terminate,true);
  await assert.rejects(tools.remember_work.execute('3',{...input,evidence:'amber\r\nviolet'}),/已停止/);
  session.state.messages.push({role:'user',content:'新的保存任务'});events.before_agent_start();events.tool_result({toolName:'mcp_discover',content:[{type:'text',text:'AVAILABLE_TOOL_SCHEMA_SENTINEL'}]});events.tool_result({toolName:'mcp_call',input:{arguments:{command:'broken'}},isError:true,content:[{type:'text',text:'Parser error'}]});events.tool_result({toolName:'mcp_call',input:{arguments:{command:"Write-Output 'amber'; Write-Output 'violet'"}},content:[{type:'text',text:JSON.stringify({exitCode:0,stdout:'amber\r\nviolet'})}]});
  const accepted=await tools.remember_work.execute('3',{...input,evidence:'amber\r\nviolet'});assert.equal(accepted.details.receipt.id,'verified');assert.equal(saved.length,1);assert.ok(reviews[0].some(t=>!t.ok),'相关失败原文仍交给审查');assert.ok(reviews[0].some(t=>t.ok));assert.ok(reviews[0].every(t=>t.tool!=='mcp_discover'),'无关工具目录不增加保存审查负担');
  await extension.consolidate();assert.equal(backgroundCalls,0,'前台已处理的证据不再重复后台提取');
  events.tool_result({toolName:'mcp_call',input:{arguments:{command:'next broken'}},isError:true,content:[{type:'text',text:'Next parser error'}]});
  events.tool_result({toolName:'mcp_call',input:{arguments:{command:'Write-Output next'}},content:[{type:'text',text:JSON.stringify({exitCode:0,stdout:'next'})}]});
  await extension.consolidate();assert.equal(backgroundCalls,1,'后续新的失败与成功仍可触发整理');
  session.state.messages.push({role:'user',content:'新的任务'});assert.equal(events.tool_call({toolName:'remember_work',input}),undefined);
  for(let i=0;i<4;i++)await assert.rejects(tools.remember_work.execute('rename-'+i,{...input,title:'不同标题'+i}),/未保存/);
  assert.equal(events.tool_call({toolName:'remember_work',input:{...input,title:'又改标题'}}).terminate,true);
});
