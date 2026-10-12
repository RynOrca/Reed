import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from './memory.mjs';
import {LearnerStore} from './learner.mjs';
import {similarTopic,semanticMatcher} from './memory-match.mjs';
import {workMemoryExtension} from './work-memory.mjs';
const fixture=async run=>{const root=await mkdtemp(join(tmpdir(),'reed-progressive-'));try{await mkdir(join(root,'sessions'));await run(root);}finally{await rm(root,{recursive:true,force:true});}};

test('同主题补充内容，区分不同章节，重读保留工作记忆',()=>fixture(async root=>{
  const memory=new MemoryStore(root,join(root,'sessions'));
  await memory.applyAgentUpdate({facts:[{key:'线性代数',content:'学习矩阵'}],notes:[{title:'Python 函数',body:'默认参数'}]},'a');
  await memory.applyAgentUpdate({facts:[{key:'线性代数学习目标',content:'练习特征值'}],notes:[{title:'Python函数',body:'关键字参数'}]},'b');
  assert.equal(memory.state.facts.length,1);assert.match(memory.state.facts[0].content,/矩阵[\s\S]*特征值/);assert.equal(memory.state.notes.length,1);assert.match(memory.state.notes[0].body,/默认参数[\s\S]*关键字/);
  assert.equal(similarTopic('线性代数第1章','线性代数第2章'),false);
  await memory.rememberWork({kind:'shell',title:'PowerShell 语法',body:'多条命令用换行分隔'},'tool');
  const loaded=new MemoryStore(root,join(root,'sessions'));await loaded.load();assert.match(loaded.workContext('PowerShell'),/换行/);
  await loaded.setEnabled('l2',false);assert.match(loaded.workContext('PowerShell'),/换行/);await loaded.setEnabled('work',false);assert.equal(loaded.workContext('PowerShell'),'');
}));

test('默认上下文无复习条目、证据原文和知识正文，按需读取受门控',()=>fixture(async root=>{
  const memory=new MemoryStore(root,join(root,'sessions')),learner=new LearnerStore(root);
  await memory.saveNote({title:'矩阵',body:'DETAIL_SENTINEL'});await memory.saveNote({title:'待复习矩阵',body:'REVIEW_SENTINEL'});
  await learner.record({kind:'concept',subject:'矩阵',detail:'学习过矩阵',evidence:'已经学过矩阵'},'s',['已经学过矩阵']);
  assert.doesNotMatch(learner.context(),/矩阵|已经学过/);assert.match(learner.context({review:true}),/矩阵/);
  assert.doesNotMatch(await memory.context('矩阵','s'),/DETAIL_SENTINEL|REVIEW_SENTINEL|待复习/);
  let profile=false,review=false;const tools={},events={};const session={sessionId:'s',state:{messages:[]}};
  workMemoryExtension({memory,learner,roles:{current:()=>({learnerProfileEnabled:profile})},currentSession:()=>session,reviewEnabled:()=>review,send(){}})({registerTool:t=>tools[t.name]=t,on:(n,f)=>events[n]=f});
  await assert.rejects(tools.recall_memory.execute('1',{area:'knowledge',query:'矩阵'}),/关闭/);profile=true;
  await assert.rejects(tools.recall_memory.execute('1',{area:'review',query:'矩阵'}),/先加载/);review=true;
  assert.match(JSON.stringify(await tools.recall_memory.execute('1',{area:'review',query:'矩阵'})),/矩阵/);
}));

test('画像关闭仍能保存工具经验，无工具证据和禁写会话不能保存',()=>fixture(async root=>{
  const memory=new MemoryStore(root,join(root,'sessions')),tools={},events={},session={sessionId:'s',state:{messages:[]}};
  workMemoryExtension({memory,learner:{},roles:{current:()=>({learnerProfileEnabled:false})},currentSession:()=>session,reviewEnabled:()=>false,send(){}})({registerTool:t=>tools[t.name]=t,on:(n,f)=>events[n]=f});
  const input={kind:'shell',title:'PowerShell 命令',body:'使用分号分隔命令',evidence:'Unexpected token'};
  await assert.rejects(tools.remember_work.execute('1',input),/证据/);events.before_agent_start();events.tool_result({toolName:'mcp_call',content:[{type:'text',text:'Unexpected token'}],isError:true});
  events.tool_result({toolName:'mcp_call',content:[{type:'text',text:'Command succeeded'}],isError:false});await tools.remember_work.execute('1',input);assert.equal(memory.state.working.length,1);
  session.state.messages.push({role:'user',content:'不要保存到长期记忆'});await assert.rejects(tools.remember_work.execute('1',input),/关闭/);
}));

test('语义判定仅接受有效同主题索引，失败时保留独立条目',async()=>{
  const items=[{subject:'矩阵乘法'}];let output='{"index":0}';
  const match=semanticMatcher({model:()=>({id:'test'}),runtime:async()=>({completeSimple:async()=>({stopReason:'stop',content:[{type:'text',text:output}]})})});
  assert.equal(await match('两个矩阵相乘',items,'subject'),items[0]);output='{"index":99}';assert.equal(await match('不同主题',items,'subject'),null);
});

import {hasRequiredReview} from './role-skills.mjs';
test('只有实际匹配的必选复习技能可预先授权，其他技能正文不能冒充',()=>{
  const caps={state:{skills:[{id:'review',name:'spaced-review',enabled:true},{id:'other',name:'other',enabled:true,description:'必选流程：spaced-review'}]}};
  assert.equal(hasRequiredReview({skills:[{skillId:'other',required:true}]},caps,'复习'),false);
  assert.equal(hasRequiredReview({skills:[{skillId:'review',required:false}]},caps,'复习'),false);
  const role={skills:[{skillId:'review',required:true}]};assert.equal(hasRequiredReview(role,caps,'复习'),true);assert.equal(hasRequiredReview(role,caps,'普通问题'),false);caps.state.skills[0].enabled=false;assert.equal(hasRequiredReview(role,caps,'复习'),false);
});
