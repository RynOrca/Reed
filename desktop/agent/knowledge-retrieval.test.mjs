import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityStore} from './capabilities.mjs';
import {createNoteRetriever} from './note-retrieval.mjs';
import {createLearningTools} from './learning-tools.mjs';
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'reed-rag-test-'));try{await mkdir(join(root,'vault'));await fn(root,join(root,'vault'));}finally{await rm(root,{recursive:true,force:true});}};

test('同义知识点展开召回原文与行号，计划缓存但笔记内容实时刷新',()=>fixture(async(dir,root)=>{
  const path=join(root,'线代.md');await writeFile(path,'# 特征值\n\n矩阵的不变方向。');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;let calls=0,output='{"queries":["特征值"]}';
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async()=>{calls++;return {stopReason:'stop',content:[{type:'text',text:output}]};}})});
  const hits=await retrieve('eigenvalue',{overview:'数学目录'});assert.equal(hits[0].path,path);assert.match(hits[0].url,/#L/);assert.match(hits[0].content,/特征值|不变方向/);
  await new Promise(r=>setTimeout(r,20));await writeFile(path,'# 特征值\n\n新内容：特征值求解。');
  assert.ok((await retrieve('eigenvalue',{overview:'数学目录'})).some(h=>h.content.includes('新内容')));assert.equal(calls,1);
  output='invalid';assert.ok((await retrieve('特征值')).length);assert.equal(calls,2);
}));

test('队列消息每次刷新笔记上下文，断开后清除旧资料',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'矩阵.md'),'# 矩阵\n线性变换');const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  const events={};const tools=createLearningTools({capabilities:caps,currentWorkspace:()=>dir,roles:{current:()=>({})},send(){},vaultOverview:{context:async()=>'数学：矩阵'}});
  tools.extension({registerTool(){},on:(name,fn)=>events[name]=fn});
  const event={messages:[{role:'system',content:''},{role:'user',content:'矩阵'}]};
  const first=(await events.context_with_system(event)).messages.at(-1).sections;assert.match(first.summon_notes,/矩阵.md/);assert.match(first.summon_note_policy,/主动调用/);
  caps.state.vaultPath=null;const second=(await events.context_with_system(event)).messages.at(-1).sections;assert.equal(second.summon_notes,null);assert.equal(second.summon_vault_overview,null);tools.close();
}));
