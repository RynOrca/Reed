import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityStore} from './capabilities.mjs';
import {createNoteRetriever,NOTE_EXPANSION_MAX_TOKENS,NOTE_EXPANSION_TIMEOUT_MS} from './note-retrieval.mjs';
import {createLearningTools} from './learning-tools.mjs';
import {LocalSearchIndex} from './local-search.mjs';
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'reed-rag-test-'));try{await mkdir(join(root,'vault'));await fn(root,join(root,'vault'));}finally{await rm(root,{recursive:true,force:true});}};

test('同义知识点展开召回原文与行号，计划缓存但笔记内容实时刷新',()=>fixture(async(dir,root)=>{
  const path=join(root,'线代.md');await writeFile(path,'# 特征值\n\n矩阵的不变方向。');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;let calls=0,output='{"queries":["特征值"]}';
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async()=>{calls++;return {stopReason:'stop',content:[{type:'text',text:output}]};}})});
  const hits=await retrieve('eigenvalue',{overview:'数学目录'});assert.equal(hits[0].path,path);assert.match(hits[0].url,/#L/);assert.match(hits[0].content,/特征值|不变方向/);
  await new Promise(r=>setTimeout(r,20));await writeFile(path,'# 特征值\n\n新内容：特征值求解。');
  assert.ok((await retrieve('eigenvalue',{overview:'数学目录'})).some(h=>h.content.includes('新内容')));assert.equal(calls,1);
  output='invalid';assert.ok((await retrieve('特征值')).length);assert.equal(calls,1,'精确标题匹配不调用规划器');
  assert.ok((await retrieve('特征值怎么求')).length);assert.equal(calls,2,'弱匹配时规划失败仍回退原查询结果');
}));

test('精确标题命中时跳过模型扩词',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'矩阵.md'),'# 矩阵\n分解方法');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;let calls=0;
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async()=>{calls++;return {stopReason:'stop',content:[{type:'text',text:'{"queries":[]}'}]};}})});
  assert.equal((await retrieve('矩阵')).length,1);assert.equal(calls,0);
}));

test('三条弱关键词命中仍请求模型扩词',()=>fixture(async(dir,root)=>{
  for(let i=0;i<3;i++)await writeFile(join(root,`弱命中${i}.md`),`# 主题${i}\n量子关系的背景${i}`);
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;let calls=0;
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async()=>{calls++;return {stopReason:'stop',content:[{type:'text',text:'{"queries":[]}'}]};}})});
  assert.equal((await retrieve('量子纠缠')).length,3);assert.equal(calls,1);
}));

test('弱命中扩词使用有界预算、关闭思考并可实际召回同义笔记',()=>fixture(async(dir,root)=>{
  const path=join(root,'线代.md');await writeFile(path,'# 特征值\n\n矩阵的不变方向。');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;let calls=0,optionsSeen;
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async(_model,_request,options)=>{calls++;optionsSeen=options;return {stopReason:'stop',content:[{type:'text',text:'{"queries":["特征值"]}'}]};}})});
  const hits=await retrieve('eigenvalue geometry');
  assert.equal(calls,1);assert.equal(optionsSeen.maxTokens,NOTE_EXPANSION_MAX_TOKENS);assert.equal(NOTE_EXPANSION_MAX_TOKENS,1024);
  assert.equal(optionsSeen.reasoning,'off');assert.ok(optionsSeen.signal instanceof AbortSignal);assert.equal(NOTE_EXPANSION_TIMEOUT_MS,5_000);
  assert.ok(hits.some(hit=>hit.path===path&&hit.content.includes('不变方向')),'有效扩词应补回原文笔记');
}));

test('自动上下文无模型前置等待，已有原文允许直接引用',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'矩阵.md'),'# 矩阵\n\n线性变换');const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  let calls=0;const handlers={};const tools=createLearningTools({capabilities:caps,currentWorkspace:()=>dir,roles:{current:()=>({})},send(){},vaultOverview:{context:async()=>'数学：矩阵'},model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async()=>{calls++;return new Promise(()=>{});}})});
  tools.extension({registerTool(){},on:(name,fn)=>handlers[name]=fn});
  const prepare=prompt=>handlers.context_with_system({messages:[{role:'system',content:''},{role:'user',content:prompt}]});
  const weak=await prepare('矩阵变换如何理解');assert.match(weak.messages.at(-1).sections.summon_notes,/线性变换/);
  assert.match(weak.messages.at(-1).sections.summon_note_policy,/无需重复检索/);
  await prepare('explain eigenvectors');assert.equal(calls,0,'弱命中和零命中均不阻塞主模型等待辅助请求');
}));

test('忽略取消的扩词服务也在截止后回退，晚到结果不会进入检索',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'矩阵.md'),'# 矩阵\n\n线性变换');const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  let finish,signalSeen,calls=0;const phases=[];
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),expansionTimeoutMs:25,runtime:async()=>({completeSimple:async(_m,_c,options)=>{calls++;if(calls>1)return {stopReason:'stop',content:[{type:'text',text:'{"queries":[]}'}]};signalSeen=options.signal;return new Promise(resolve=>finish=resolve);}})});
  const hits=await retrieve('矩阵变换如何理解',{onProgress:p=>phases.push(p.phase)});
  assert.ok(hits.some(h=>h.content.includes('线性变换')));assert.equal(signalSeen.aborted,true);assert.deepEqual(phases,['local','expanding','fallback']);
  finish({stopReason:'stop',content:[{type:'text',text:'{"queries":["秘密旧内容"]}'}]});
  const again=await retrieve('矩阵变换如何理解');assert.deepEqual(again,hits,'迟到结果不能污染后续计划');assert.equal(calls,2,'取消后后续查询可以重试扩词');
  await retrieve('矩阵变换如何理解');assert.equal(calls,2,'成功的空计划仍缓存，避免重复扩词');
}));

test('扩词服务错误不缓存为永久空结果，下一次按需查询可恢复',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'矩阵.md'),'# 矩阵\n\n线性变换');const caps=new CapabilityStore(dir);caps.state.vaultPath=root;let calls=0;
  const retrieve=createNoteRetriever({capabilities:caps,model:()=>({provider:'test',id:'rag'}),runtime:async()=>({completeSimple:async()=>{calls++;if(calls===1)throw Error('502');return {stopReason:'stop',content:[{type:'text',text:'{"queries":["矩阵"]}'}]};}})});
  await retrieve('linear algebra');assert.ok((await retrieve('linear algebra')).some(h=>h.content.includes('线性变换')));assert.equal(calls,2);
}));

test('不完整扫描保留未检查文件旧索引并暴露扫描状态',()=>fixture(async(dir,root)=>{
  const stale=join(root,'旧笔记.md'),current=join(root,'当前笔记.md');
  await writeFile(stale,'# 稀有主题\n旧索引内容');await writeFile(current,'# 其他\n正常内容');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  assert.ok((await caps.searchNotes('稀有主题')).length);
  caps.canRead=async path=>path!==stale;
  await caps.searchNotes('当前笔记');
  assert.equal(caps.snapshot().noteScanStatus.state,'incomplete');
  assert.ok(caps.snapshot().noteScanStatus.errorCount>0);
  assert.deepEqual(await caps.searchNotes('稀有主题'),[]);
  const retained=new LocalSearchIndex(join(dir,'local-search.sqlite'));
  try{assert.ok(retained.search('notes',root,'稀有主题',8).length,'拒读后旧索引保留但不披露');}finally{retained.close();}
  caps.canRead=async()=>true;
  assert.ok((await caps.searchNotes('稀有主题')).length);
}));

test('笔记库不可达时不泄露旧结果，恢复后的完整扫描清理已删除条目',()=>fixture(async(dir,root)=>{
  const note=join(root,'留存.md');await writeFile(note,'# 暂存主题\n旧内容');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  assert.ok((await caps.searchNotes('暂存主题')).length);
  caps.state.vaultPath=join(dir,'暂不可达');
  assert.deepEqual(await caps.searchNotes('暂存主题'),[]);
  assert.equal(caps.snapshot().noteScanStatus.state,'incomplete');
  caps.state.vaultPath=root;await rm(note,{force:true});
  assert.deepEqual(await caps.searchNotes('暂存主题'),[]);
  assert.equal(caps.snapshot().noteScanStatus.state,'complete');
}));

test('部分扫描中已更新文件缩短时不披露旧尾段且旧段仍留在索引',()=>fixture(async(dir,root)=>{
  const edited=join(root,'可读笔记.md'),denied=join(root,'拒绝笔记.md');
  await writeFile(edited,'# 当前内容\n保留段落\n\n# 旧尾标题\n仅旧尾段的稀有词');
  await writeFile(denied,'# 权限拒绝\n其他内容');
  const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  assert.ok((await caps.searchNotes('稀有词')).length);
  await new Promise(r=>setTimeout(r,20));
  await writeFile(edited,'# 当前内容\n缩短后的新段落');
  caps.canRead=async path=>path!==denied;
  assert.deepEqual(await caps.searchNotes('稀有词'),[]);
  assert.equal(caps.snapshot().noteScanStatus.state,'incomplete');
  const index=new LocalSearchIndex(join(dir,'local-search.sqlite'));
  try{assert.ok(index.search('notes',root,'稀有词',8).some(hit=>hit.payload.content.includes('仅旧尾段')));}
  finally{index.close();}
}));

test('队列消息每次刷新笔记上下文，断开后清除旧资料',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'矩阵.md'),'# 矩阵\n线性变换');const caps=new CapabilityStore(dir);caps.state.vaultPath=root;
  const events={};const tools=createLearningTools({capabilities:caps,currentWorkspace:()=>dir,roles:{current:()=>({})},send(){},vaultOverview:{context:async()=>'数学：矩阵'}});
  tools.extension({registerTool(){},on:(name,fn)=>events[name]=fn});
  const event={messages:[{role:'system',content:''},{role:'user',content:'矩阵'}]};
  const first=(await events.context_with_system(event)).messages.at(-1).sections;assert.match(first.summon_notes,/矩阵.md/);assert.match(first.summon_note_policy,/主动调用/);
  caps.state.vaultPath=null;const second=(await events.context_with_system(event)).messages.at(-1).sections;assert.equal(second.summon_notes,null);assert.equal(second.summon_vault_overview,null);tools.close();
}));
