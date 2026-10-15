import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationCanvasStore,ConversationCanvasWorkflow,conversationPairs,canvasSource} from './conversation-canvas.mjs';
const fixture=async run=>{const root=await mkdtemp(join(tmpdir(),'reed-canvas-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}};
const pair=(id,question='测试问题',answer='有依据的回答')=>[{type:'message',id:'u'+id,message:{role:'user',content:question}},{type:'message',id:'a'+id,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:answer}]}}];
const analysis=(id,relations=[])=>({id,title:'归纳的问题',summary:'忠实的摘要',relations});

test('画布抽取跳过工具/失败回复，保留稳定消息标识和显式追问来源',()=>{
  const entries=[...pair(1),{type:'message',id:'u2',message:{role:'user',content:'追问'}},{type:'message',id:'tool',message:{role:'assistant',content:[{type:'toolCall',name:'read'}]}},{type:'message',id:'a2',message:{role:'assistant',content:[{type:'text',text:'回答'}]}},{type:'custom',customType:'reed_canvas_parent',data:{userEntryId:'u2',parentNodeId:'u1'}}];
  const pairs=conversationPairs(entries);assert.equal(pairs.length,2);assert.equal(pairs[1].parentNodeId,'u1');assert.equal(pairs[1].answerMessageId,'a2');
  assert.equal(conversationPairs(pair(3).map(e=>e.id==='a3'?{...e,message:{...e.message,stopReason:'error'}}:e)).length,0);
});
test('会话图重载、增量幂等、手工布局/标题不被整理覆盖，原文不复制进图文件',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root),entries=[...pair(1),...pair(2),{type:'custom',customType:'reed_canvas_parent',data:{userEntryId:'u2',parentNodeId:'u1'}}];
  let graph=await store.sync('session-1',entries);assert.equal(graph.nodes.length,0);assert.equal(graph.records.u1.status,'pending');
  await store.analyze('session-1',[analysis('u1'),analysis('u2')],['u1','u2']);
  await store.edit('session-1',{nodes:[{id:'u2',x:99,y:88,title:'手工标题',collapsed:true}],view:{x:50,y:-40,scale:.8}});
  await store.analyze('session-1',[analysis('u1'),analysis('u2')],['u1','u2']);
  graph=await store.sync('session-1',entries);assert.equal(graph.nodes.length,2);assert.equal(graph.nodes[1].title,'手工标题');assert.equal(graph.nodes[1].x,99);assert.equal(graph.nodes[1].collapsed,true);assert.equal(graph.edges[0].explicit,true);
  const reopened=await new ConversationCanvasStore(root).get('session-1');assert.deepEqual(reopened,graph);assert.equal(reopened.view.scale,.8);
  assert.doesNotMatch(await readFile(store.path('session-1'),'utf8'),/有依据的回答/);
}));
test('格式、越界引用和前向环路被拒绝且不破坏已有图',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root);await store.sync('s',[...pair(1),...pair(2)]);const original=await store.analyze('s',[analysis('u1'),analysis('u2')],['u1','u2']);
  await assert.rejects(store.get('../other'),/标识/);
  await assert.rejects(store.edit('s',{nodes:[{id:'u1',x:NaN,y:0}]}),/坐标/);
  await assert.rejects(store.analyze('s',[analysis('u1',[{parentId:'u2',type:'深入'}])],['u1']),/关联/);
  await assert.rejects(store.analyze('s',[analysis('u2',[{parentId:'outside',type:'深入'}])],['u2']),/关联/);
  await assert.rejects(store.analyze('s',[],['u1']),/缺少/);
  assert.deepEqual(await store.get('s'),original);
}));
test('整理工作流只有打开时执行、分批使用当前模型，错误保留待整理卡片',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root),events=[];let calls=0,bad=false;
  const session={sessionId:'s',model:{provider:'mock',id:'chosen'},sessionManager:{getBranch:()=>[...pair(1),...pair(2)]}};
  const workflow=new ConversationCanvasWorkflow({store,currentSession:()=>session,enabled:()=>true,send:e=>events.push(e),runtime:async()=>({completeSimple:async(model,context,options)=>{assert.equal(model.id,'chosen');assert.equal(options.reasoning,'off');assert.equal(options.requestPriority,'background');calls++;return {stopReason:'stop',content:[{type:'text',text:bad?'bad json':JSON.stringify({nodes:JSON.parse(context.messages[0].content[0].text).turns.map(turn=>analysis(turn.id))})}]};}})});
  await workflow.refresh();assert.equal(calls,0);await workflow.open();bad=true;await workflow.refresh();assert.equal(events.at(-1).state,'error');assert.equal((await store.get('s')).records.u1.status,'pending');bad=false;await workflow.refresh();assert.equal(events.at(-1).state,'ready');assert.equal((await store.get('s')).nodes[0].state,'ready');await workflow.refresh();assert.equal(calls,2,'处理完成不重复请求');workflow.close();
}));

test('候选不先建卡片，寒暄不调用模型；无关新主题可回补为独立根并合并补充',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root);let entries=[...pair(1,'RAG为什么切块？'),...pair(2,'顺便问一个数据库问题')],calls=0;
  const session={sessionId:'s',model:{provider:'mock',id:'test'},sessionManager:{getBranch:()=>entries}};
  const workflow=new ConversationCanvasWorkflow({store,currentSession:()=>session,enabled:()=>true,send(){},runtime:async()=>({completeSimple:async(_,context)=>{
    calls++;const input=JSON.parse(context.messages[0].content[0].text);const nodes=input.turns.map(p=>p.id==='u1'?analysis(p.id):p.id==='u2'?(entries.length===4?{id:p.id,action:'defer'}:{...analysis(p.id),action:'include',title:'数据库事务'}):p.id==='u3'?{...analysis(p.id),action:'merge',targetId:'u2',summary:'事务保证一致性，隔离级别控制并发可见性。'}:analysis(p.id));
    return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({nodes})}]};
  }})});
  await workflow.open();assert.equal((await store.get('s')).nodes.length,0);await workflow.refresh();let graph=await store.get('s');assert.equal(graph.nodes.length,1);assert.equal(graph.records.u2.status,'deferred');const previous=calls;await workflow.refresh();assert.equal(calls,previous);
  entries.push(...pair(3,'事务隔离级别如何工作？','数据库的并发可见性'));await workflow.refresh();graph=await store.get('s');assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,0);assert.deepEqual(graph.nodes.find(n=>n.id==='u2').turnIds,['u2','u3']);assert.match(canvasSource(graph,entries,'u2').question,/隔离级别/);assert.match(canvasSource(graph,entries,'u2').answer,/并发可见性/);
  entries.push(...pair(4,'好的，谢谢'));await workflow.refresh();assert.equal(calls,previous+1);assert.equal((await store.get('s')).records.u4.status,'ignored');
}));

test('手动收录/隐藏持久化，恢复合并卡片原文且自动整理不复活隐藏卡片',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root),entries=[...pair(1),...pair(2,'补充说明')];await store.sync('s',entries);
  await store.analyze('s',[analysis('u1'),{...analysis('u2'),action:'merge',targetId:'u1'}],['u1','u2']);await store.edit('s',{nodes:[{id:'u1',x:120,y:140,title:'手工标题'}]});await store.hide('s','u1');
  await store.sync('s',[...entries,...pair(3)]);let graph=await new ConversationCanvasStore(root).get('s');assert.equal(graph.nodes[0].hidden,true);assert.equal(graph.records.u2.manualHidden,true);assert.throws(()=>canvasSource(graph,entries,'u1'),/不存在/);
  graph=await store.include('s',conversationPairs(entries)[1]);assert.equal(graph.nodes.length,1);assert.equal(graph.nodes[0].hidden,false);assert.equal(graph.nodes[0].x,120);assert.equal(graph.nodes[0].title,'手工标题');assert.equal(canvasSource(graph,entries,'u1').userMessageIds.length,2);
  await store.hide('s','u1');await assert.rejects(store.analyze('s',[analysis('u1')],['u1']),/错误节点/);assert.equal((await store.get('s')).nodes[0].hidden,true);
}));

test('非法合并/收录结果不能部分写入，旧画布升级保留已有手工卡片',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root),entries=[...pair(1),...pair(2)];await store.sync('s',entries);
  const before=await store.get('s');await assert.rejects(store.analyze('s',[analysis('u1'),{...analysis('u2'),action:'merge',targetId:'missing'}],['u1','u2']),/合并/);assert.deepEqual(await store.get('s'),before);
  await store.include('s',conversationPairs(entries)[0]);await assert.rejects(store.analyze('s',[{id:'u1',action:'ignore'}],['u1']),/手工节点/);
}));
test('取消或删除后，忽略 abort 的迟到模型结果不能改图或复活文件',()=>fixture(async root=>{
  const store=new ConversationCanvasStore(root),session={sessionId:'s',model:{provider:'mock',id:'test'},sessionManager:{getBranch:()=>pair(1)}};let finish,started;
  const reached=new Promise(r=>started=r);const workflow=new ConversationCanvasWorkflow({store,currentSession:()=>session,enabled:()=>true,send(){},runtime:async()=>({completeSimple:()=>{started();return new Promise(r=>finish=r);}})});
  await workflow.open();const task=workflow.refresh();await reached;workflow.close();await store.remove('s');finish({stopReason:'stop',content:[{type:'text',text:JSON.stringify({nodes:[analysis('u1')]})}]});await task;
  await assert.rejects(access(store.path('s')),/ENOENT/);await assert.rejects(store.get('s'),/已删除/);
}));
