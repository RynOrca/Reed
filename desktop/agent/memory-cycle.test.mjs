import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore} from './memory.mjs';
import {LearnerStore} from './learner.mjs';
import {createWorkRecaller} from './work-recall.mjs';
import {workMemoryExtension} from './work-memory.mjs';
import {LocalSearchIndex} from './local-search.mjs';
import {CapabilityStore} from './capabilities.mjs';
import {prepareRoleSkills} from './role-skills.mjs';
const fixture=async fn=>{const root=await mkdtemp(join(tmpdir(),'reed-memory-cycle-'));try{await mkdir(join(root,'sessions'));await fn(root,new MemoryStore(root,join(root,'sessions')));}finally{await rm(root,{recursive:true,force:true});}};

test('超过50条不淘汰旧经验，重启后仍可通过本地索引找回',()=>fixture(async(root,memory)=>{
  for(let i=0;i<55;i++)await memory.rememberWork({kind:'workflow',title:`独立流程${i}`,body:i===0?'legacyneedle：已验证的旧方法':`流程编号${i}`},'test');
  const loaded=new MemoryStore(root,join(root,'sessions'));await loaded.load();assert.equal(loaded.state.working.length,55);assert.match(loaded.workContext('legacyneedle'),/旧方法/);
}));

test('纠正替换当前结论，失效后不再召回，完整修订与证据重启保留',()=>fixture(async(root,memory)=>{
  const first=await memory.rememberWork({kind:'shell',title:'Bash 引号',body:'旧方法',evidence:'Verified result'},'s');assert.equal(first.operation,'create');
  const replacement=await memory.rememberWork({kind:'shell',title:'Bash 引号',body:'新方法',operation:'replace',targetId:first.id,evidence:'Verified new result',trigger:'参数含空格',steps:'添加单引号',verification:'退出码0'},'s');assert.equal(replacement.revision,2);
  assert.doesNotMatch(memory.workContext('Bash'),/旧方法/);assert.equal(memory.state.working[0].revisions[0].body,'旧方法');
  const loaded=new MemoryStore(root,join(root,'sessions'));await loaded.load();assert.equal(loaded.state.working[0].body,'新方法');
  const draft=await loaded.createWorkSkillDraft(first.id);assert.match(draft.body,/适用条件[\s\S]*参数含空格/);assert.match(draft.body,/验证办法[\s\S]*退出码0/);
  const capabilities=new CapabilityStore(root);const skillId=await capabilities.importSkill(draft.dir);capabilities.canUseSkill=skill=>!skill.experienceId||loaded.workItems('').some(i=>i.id===skill.experienceId&&i.revision===skill.experienceRevision);assert.equal(capabilities.enabledSkills().length,1);
  await writeFile(draft.path,'用户修改的草稿');assert.equal((await loaded.createWorkSkillDraft(first.id)).body,'用户修改的草稿');
  await loaded.rememberWork({kind:'shell',title:'Bash 引号',body:'版本已变，停止使用',operation:'invalidate',targetId:first.id,evidence:'Verified obsolete'},'s');assert.equal(loaded.workContext('Bash'),'');
  assert.equal(capabilities.enabledSkills().length,0);await assert.rejects(prepareRoleSkills({skills:[{skillId,required:true}]},capabilities,`/skill ${capabilities.state.skills[0].name}`),/停用/);
  const again=new MemoryStore(root,join(root,'sessions'));await again.load();assert.equal(again.state.working[0].status,'invalidated');assert.equal(again.state.working[0].revisions.length,3);
  const index=new LocalSearchIndex(join(root,'local-search.sqlite'));assert.deepEqual(index.search('work','','Bash'),[]);index.close();
}));

test('换表达时按需展开，普通聊天不调用模型，结果缓存',()=>fixture(async(_root,memory)=>{
  await memory.rememberWork({kind:'shell',title:'PowerShell quoting',body:'argument escaping',trigger:'quoted arguments'},'s');let calls=0;
  const recall=createWorkRecaller({memory,model:()=>({provider:'test',id:'work'}),runtime:async()=>({completeSimple:async()=>{calls++;return {stopReason:'stop',content:[{type:'text',text:'{"query":"PowerShell quoting"}'}]};}})});
  assert.equal((await recall('今天心情不错')).items.length,0);assert.equal(calls,0);
  assert.equal((await recall('继续处理带空格的参数')).basis,'expanded');assert.equal((await recall('继续处理带空格的参数')).items.length,1);assert.equal(calls,1);
}));

test('普通成功读取不触发工作经验后台整理',()=>fixture(async(_root,memory)=>{
  const hooks={};let calls=0;const session={sessionId:'s',model:{provider:'test',id:'work'},state:{messages:[{role:'user',content:'读一下文件'}]}};
  const extension=workMemoryExtension({memory,learner:{},roles:{current:()=>({})},currentSession:()=>session,reviewEnabled:()=>false,send(){},runtime:async()=>{calls++;throw Error('不应调用');}});
  extension({registerTool(){},on:(n,f)=>hooks[n]=f});hooks.before_agent_start();hooks.tool_result({toolName:'read',input:{path:'ordinary.md'},content:[{type:'text',text:'ordinary'}]});await extension.consolidate();assert.equal(calls,0);
}));

test('画像显式纠正替换旧目标，保留用户证据和完整事件，重启一致',()=>fixture(async(root,memory)=>{
  const learner=new LearnerStore(root);await learner.record({kind:'goal',subject:'线性代数',detail:'今年学线性代数',evidence:'今年学线性代数'},'s',['今年学线性代数']);
  await learner.record({kind:'goal',subject:'微积分',targetSubject:'线性代数',operation:'replace',detail:'现在改学微积分',evidence:'现在改学微积分'},'s',['现在改学微积分']);
  assert.equal(learner.state.goals.length,1);assert.equal(learner.state.goals[0].subject,'微积分');assert.doesNotMatch(learner.context({query:'微积分'}),/线性代数/);
  const loaded=new LearnerStore(root);await loaded.load();assert.equal(loaded.state.events.length,2);assert.equal(loaded.state.goals[0].detail,'现在改学微积分');
  await memory.applyAgentUpdate({facts:[{key:'讲解偏好',content:'先给结论'}]},'s');await memory.applyAgentUpdate({facts:[{key:'讲解偏好',content:'现在先讲原理',operation:'replace'}]},'s');
  const restored=new MemoryStore(root,join(root,'sessions'));await restored.load();assert.equal(restored.state.facts[0].content,'现在先讲原理');assert.equal(restored.state.facts[0].revisions[0].content,'先给结论');
  await restored.saveNote({title:'个人结论',body:'旧结论'});await restored.applyAgentUpdate({notes:[{title:'个人结论',body:'新结论',operation:'replace'}]},'s');
  const again=new MemoryStore(root,join(root,'sessions'));await again.load();assert.equal(again.state.notes[0].revisions[0].body,'旧结论');
}));

test('同项目已知Shell不交叉召回，删除清理索引，采用相反结果都保留',()=>fixture(async(root,memory)=>{
  const a=await memory.rememberWork({kind:'shell',title:'参数引号',body:'Bash quoted arguments'},'s');
  await memory.rememberWork({kind:'shell',title:'参数引号',body:'PowerShell quoted arguments'},'s');
  assert.ok(memory.workMatches('PowerShell quoted').every(i=>!i.body.includes('Bash')));
  memory.workMatches('Bash');await memory.deleteWork(undefined,a.id);const index=new LocalSearchIndex(join(root,'local-search.sqlite'));assert.ok(index.list('work','').every(i=>i.id!==a.id));index.close();
  for(const outcome of ['success','failure'])await memory.recordWorkUse({kind:'reported_use',ids:['id'],source:'s',basis:'tool',outcome});
  const events=(await readFile(join(root,'work-usage.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.outcome),['success','failure']);
}));

test('短画像满额明确报错，不声称已保存；界面快照不携带完整修订正文',()=>fixture(async(_root,memory)=>{
  memory.state.facts=Array.from({length:40},(_,i)=>({key:`主题${i}`,content:`背景${i}`}));
  await assert.rejects(memory.applyAgentUpdate({facts:[{key:'全新偏好',content:'明确的新偏好'}]},'s'),/已满/);assert.equal(memory.state.facts.length,40);
  const receipt=await memory.rememberWork({kind:'workflow',title:'可复用流程',body:'验证通过',evidence:'verified'},'s');
  assert.ok(memory.state.working[0].revisions.length);assert.equal(memory.snapshot().working.find(i=>i.id===receipt.id).revisions,undefined);
}));
