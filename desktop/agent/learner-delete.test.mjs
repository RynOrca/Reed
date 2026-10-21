import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LearnerStore} from './learner.mjs';

async function fixture(run){const root=await mkdtemp(join(tmpdir(),'reed-test-forget-'));try{await run(new LearnerStore(root),root);}finally{await rm(root,{recursive:true,force:true});}}
const entry=(subject,kind='concept',extra={})=>({kind,subject,detail:`已学${subject}`,evidence:`我学过${subject}`,...extra});
const record=(store,event)=>store.record(event,'test-session',[event.evidence]);
test('删除知识移除概念及复习事件，重启/召回/复习队列不再出现，同主题不自动重建',()=>fixture(async(store,root)=>{
  await record(store,entry('矩阵'));await record(store,entry('矩阵','review',{result:'independent'}));await record(store,entry('导数'));
  const item=store.snapshot().knowledge.find(item=>item.subject==='矩阵');await store.deleteItem('knowledge',item.id);
  assert.doesNotMatch(JSON.stringify(store.snapshot()),/矩阵/);assert.doesNotMatch(JSON.stringify(store.reviewQueue()),/矩阵/);
  const restored=new LearnerStore(root);await restored.load();assert.equal(restored.state.events.length,1);assert.equal(restored.state.knowledge[0].subject,'导数');
  await assert.rejects(record(restored,entry('矩阵')),/已由用户删除/);
  assert.doesNotMatch(await readFile(store.path,'utf8'),/我学过矩阵/);
}));
test('纠正重命名后的条目删除包含原主题，其他分类同主题保留',()=>fixture(async store=>{
  await record(store,entry('线性代数','preference'));await record(store,entry('微积分','preference',{operation:'replace',targetSubject:'线性代数'}));
  await record(store,entry('线性代数','misconception'));
  await store.deleteItem('preferences',store.state.preferences[0].id);
  assert.equal(store.state.preferences.length,0);assert.equal(store.state.misconceptions.length,1);
  await assert.rejects(record(store,entry('线性代数','preference')),/已由用户删除/);
}));
test('删除与异步主题匹配竞争时拒绝旧写入',()=>fixture(async store=>{
  await record(store,entry('矩阵'));let release,started;const ready=new Promise(resolve=>started=resolve);
  store.matchTopic=async()=>{started();return new Promise(resolve=>release=resolve);};
  const pending=record(store,entry('向量'));await ready;
  await store.deleteItem('knowledge',store.state.knowledge[0].id);release(null);
  await assert.rejects(pending,/已由用户删除/);assert.equal(store.state.events.length,0);
}));
test('旧画像目标只留历史不参与设置画像或模型召回，Agent 新目标写入被拒绝',()=>fixture(async(store,root)=>{
  await writeFile(store.path,JSON.stringify({events:[{id:'old-goal',kind:'goal',subject:'旧目标哨兵',detail:'过期目标',evidence:'旧原话',source:'test',time:new Date().toISOString()}]}));
  await store.load();assert.doesNotMatch(JSON.stringify(store.snapshot()),/旧目标哨兵/);assert.doesNotMatch(store.context(),/旧目标哨兵/);assert.deepEqual(store.recall(),[]);
  await assert.rejects(record(store,entry('新目标','goal')),/仅由用户/);
}));
