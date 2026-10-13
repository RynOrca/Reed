import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "./goals.mjs";
import { RoleStore } from "./roles.mjs";
import { FileScope, sandboxTools } from "./sandbox.mjs";
import { roleFeatureExtension } from "./role-features.mjs";
import { createMemoryAgent } from "./memory-agent.mjs";
import { learnerExtension } from "./learner.mjs";
import { VaultOverview, OVERVIEW_FILE } from "./vault-overview.mjs";
import { goalTasks } from "../web/goal-tasks.js";

async function fixture(run) {const root=await mkdtemp(join(tmpdir(),"reed-workspace-test-"));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
function hooks(){const events={},tools={};return {events,tools,pi:{on:(n,f)=>events[n]=f,registerTool:t=>tools[t.name]=t}};}

test("项目目标按路径区分同名项目，保留 Markdown，拒绝过期版本覆盖",()=>fixture(async root=>{
  const store=new GoalStore(root);await store.initialize();const a=join(root,"a","math"),b=join(root,"b","math");await mkdir(a,{recursive:true});await mkdir(b,{recursive:true});
  const first=await store.read(a),other=await store.read(b);assert.notEqual(first.path,other.path);
  const source="# 大目标\n\n## 第一阶段\n- [ ] 小目标\n";
  const saved=await store.save(a,source,first.revision);assert.equal(saved.body,source);assert.match(await readFile(saved.path,"utf8"),/reed_goal_format: 1/);
  await assert.rejects(store.save(a,"覆盖",first.revision),/已在其他/);assert.equal((await store.read(a)).body,source);
  assert.equal(await store.section(a,false),null);assert.match(await store.section(a,true),/小目标/);
}));

test("目标只读与角色读取限制优先于完全文件权限，递归搜索不会泄漏",()=>fixture(async root=>{
  const privateDir=join(root,"learning-goals");await mkdir(privateDir);const file=join(privateDir,"test.md");await writeFile(file,"private-goal");
  let enabled=false;const scope=new FileScope({workspace:()=>root,readOnly:()=>[],fullAccess:()=>true,protectedPaths:()=>[{path:privateDir,denyRead:!enabled}]});
  await assert.rejects(scope.check(file),/角色权限/);assert.equal((await scope.entries(root,true)).some(x=>x.path===file),false);
  const grep=sandboxTools(scope).find(t=>t.name==="grep");assert.doesNotMatch((await grep.execute("test",{path:root,pattern:"private-goal"})).content[0].text,/private-goal/);
  enabled=true;assert.equal(await scope.check(file),file);await assert.rejects(scope.check(file,true),/角色权限/);await assert.rejects(scope.check(privateDir,true),/角色权限/);
}));

test("角色开关持久化，关闭后每次请求清除记忆段，开启目标每次读取新内容",()=>fixture(async root=>{
  const roles=new RoleStore(root);assert.equal(roles.current().learningGoalsEnabled,false);
  await roles.save({roleId:"agent",name:"Agent",system:"教我",learningGoalsEnabled:true,learnerProfileEnabled:false});const reload=new RoleStore(root);await reload.load();assert.equal(reload.current().learningGoalsEnabled,true);
  const h=hooks();let text="第一版",reads=0;
  roleFeatureExtension({roles:reload,goals:{section:async(_p,on)=>{reads++;return on?text:null}},project:()=>root,learner:{context(){throw Error("关闭不应读取")}},memory:{state:{enabled:{}},context(){throw Error("关闭不应召回")}},currentSession:()=>null})(h.pi);
  const event={messages:[{role:"system",content:"",sections:{summon_memory:"stale"}},{role:"user",content:"继续"}]};
  let section=(await h.events.context_with_system(event)).messages.at(-1).sections;assert.equal(section.summon_goals,"第一版");assert.equal(section.summon_memory,null);assert.equal(section.summon_learner,null);
  text="第二版";section=(await h.events.context_with_system(event)).messages.at(-1).sections;assert.equal(section.summon_goals,"第二版");assert.equal(reads,2);
  assert.equal(h.events.tool_call({toolName:"remember"}).block,true);
}));

test("画像关闭不整理、不记录、不调用模型或读取记忆",async()=>{
  const forbidden=()=>{throw Error("disabled feature accessed")};const memory={state:{enabled:{l1:true,l2:true}},context:forbidden,applyAgentUpdate:forbidden};
  const h=hooks();const agent=createMemoryAgent({memory,learner:{record:forbidden},send:forbidden,currentSession:()=>null,runtime:forbidden,enabled:()=>false});agent.extension(h.pi);
  await h.events.before_agent_start({systemPromptOptions:{sections:{}}});await agent.consolidate();agent.schedule();agent.cancel();
  assert.match((await h.tools.remember.execute("test",{layer:"profile"})).content[0].text,/已关闭/);
  const l=hooks();learnerExtension({learner:{record:forbidden,context:forbidden},memory,currentSession:()=>null,send:forbidden,enabled:()=>false})(l.pi);
  await l.events.before_agent_start({systemPromptOptions:{sections:{}}});assert.match((await l.tools.record_learning_event.execute("test",{})).content[0].text,/已关闭/);
});

test("Markdown 进度只统计真实任务，支持嵌套与引用，忽略代码块",()=>{
  const source='# 目标\n\n```md\n- [ ] 代码里的假目标\n```\n\n- [x] 一级\n  - [ ] 二级\n\n> - [ ] 引用内目标\n';
  const tasks=goalTasks(source);assert.equal(tasks.length,3);assert.deepEqual(tasks.map(t=>source[t.offset]),["x"," "," "]);
});

test("初次遍历全部 Markdown 后模型生成总览，重连不覆盖原笔记或已有总览",()=>fixture(async root=>{
  await mkdir(join(root,"数学"));await mkdir(join(root,"英语"));await writeFile(join(root,"数学","线代.md"),'# 矩阵\n线性变换');await writeFile(join(root,"英语","grammar.md"),'# Grammar\nPast tense');
  const inputs=[];const overview=new VaultOverview({capabilities:{state:{vaultPath:root}},model:()=>({provider:"test",id:"test"}),send:()=>{},runtime:async()=>({completeSimple:async(_m,ctx)=>{inputs.push(ctx.messages[0].content[0].text);return {content:[{type:"text",text:"## 目录\n数学：线性代数；英语：语法"}],stopReason:"stop"};}})});
  await overview.start();assert.equal(overview.snapshot().state,"ready");assert.match(inputs[0],/线代\.md/);assert.match(inputs[0],/grammar\.md/);const summary=await readFile(join(root,OVERVIEW_FILE),"utf8");assert.match(summary,/正文/);
  assert.equal(await readFile(join(root,"数学","线代.md"),"utf8"),'# 矩阵\n线性变换');const count=inputs.length;await overview.start();assert.equal(inputs.length,count);assert.equal(await readFile(join(root,OVERVIEW_FILE),"utf8"),summary);
}));

test("总览生成失败和取消不会创建半份文件，也不会写入后来切换的库",()=>fixture(async root=>{
  await writeFile(join(root,"test.md"),'# 测试');const caps={state:{vaultPath:root}};let release;
  const task=new VaultOverview({capabilities:caps,model:()=>({provider:"test"}),send:()=>{},runtime:async()=>({completeSimple:async()=>new Promise(resolve=>{release=resolve})})});
  const running=task.start();while(!release)await new Promise(r=>setTimeout(r,5));task.cancel();release({content:[{type:"text",text:"结果"}]});await running;await assert.rejects(readFile(join(root,OVERVIEW_FILE)),{code:"ENOENT"});
}));

test("先连接笔记库后选模型也能补上总览，且不会把选模型的报错留在界面上",()=>fixture(async root=>{
  const events=[],caps={state:{vaultPath:root}};await writeFile(join(root,"note.md"),'# 数学\n线性代数');
  let selected=null,calls=0;
  const task=new VaultOverview({capabilities:caps,send:e=>events.push(e),model:()=>selected,runtime:async()=>({completeSimple:async()=>{calls++;return {content:[{type:"text",text:"## 目录\n- 数学"}],stopReason:"stop"};}})});

  // 1) 刚连接、还没选模型：应留下等待提示而不是报错
  assert.equal(await task.ensure(),false);
  assert.equal(task.snapshot().state,"idle");
  assert.match(task.snapshot().message,/选择模型/);
  assert.equal(calls,0);
  assert.equal(events.some(e=>e.state==="error"),false,"不应出现 error 状态");

  // 2) 模型就绪后再 ensure：应真正生成
  selected={provider:"test",id:"test"};
  assert.equal(await task.ensure(),true);
  assert.equal(task.snapshot().state,"ready");
  // 每批一次摘要 + 一次最终总览合成，单批笔记就是 2 次模型调用
  assert.equal(calls,2);
  assert.match(await readFile(join(root,OVERVIEW_FILE),"utf8"),/数学/);

  // 3) 总览已存在时 ensure 不应再调用模型
  assert.equal(await task.ensure(),true);
  assert.equal(calls,2,"已存在总览时不能再次调用模型");

  // 4) 没有连接笔记库时 ensure 直接返回 false，不产生事件
  events.length=0;
  const none=new VaultOverview({capabilities:{state:{vaultPath:null}},send:e=>events.push(e),model:()=>selected,runtime:async()=>{throw Error("不应调用");}});
  assert.equal(await none.ensure(),false);
  assert.equal(events.length,0);
}));
