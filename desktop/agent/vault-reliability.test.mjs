import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VaultOverview,OVERVIEW_FILE} from './vault-overview.mjs';
import {CapabilityStore} from './capabilities.mjs';
import {UserConfig} from './user-config.mjs';
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'reed-vault-reliability-'));try{await mkdir(join(dir,'vault'));await fn(dir,join(dir,'vault'));}finally{await rm(dir,{recursive:true,force:true});}};
const model=()=>({provider:'test',id:'overview'});

test('重新加载持久配置和总览，未选择模型也不请求服务',()=>fixture(async(dir,root)=>{
  const first=new CapabilityStore(dir,{config:new UserConfig(dir)});await first.configure({vaultPath:root});
  await writeFile(join(root,OVERVIEW_FILE),'# 已保存总览\n生成模型：test/original\n用户补充');
  const loaded=new CapabilityStore(dir,{config:new UserConfig(dir)});await loaded.load();
  const task=new VaultOverview({capabilities:loaded,model:()=>null,send(){},runtime:async()=>{throw Error('不得调用模型');}});
  assert.equal(await task.restore(),true);assert.equal(task.snapshot().model,'test/original');assert.equal(await task.ensure(),true);
  assert.match(await readFile(join(root,OVERVIEW_FILE),'utf8'),/用户补充/);
}));

test('并发启动复用任务，取消后可恢复已完成批次',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'note.md'),'# 矩阵\n正文');let calls=0,release;
  const capabilities={dir,state:{vaultPath:root}},runtime=async()=>({completeSimple:async(_m,_ctx,{signal})=>{
    calls++;if(calls===2){return new Promise(resolve=>{release=()=>resolve({stopReason:'aborted',content:[]});signal.addEventListener('abort',release,{once:true});});}
    return {stopReason:'stop',content:[{type:'text',text:'数学：note.md'}]};
  }});
  const task=new VaultOverview({capabilities,model,runtime,send(){}});
  const a=task.start(),b=task.start();while(!release)await new Promise(r=>setTimeout(r,5));
  assert.equal(calls,2);task.cancel();await Promise.all([a,b]);
  const restarted=new VaultOverview({capabilities,model,send(){},runtime:async()=>({completeSimple:async()=>{calls++;return {stopReason:'stop',content:[{type:'text',text:'恢复的总览'}]};}})});
  await restarted.ensure();assert.equal(calls,3);assert.equal(restarted.snapshot().state,'ready');assert.match(await readFile(join(root,OVERVIEW_FILE),'utf8'),/生成模型：test\/overview/);
}));

test('总览任务固定独立选择的模型与思考档位，另一个模型不会复用该任务',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'note.md'),'# 矩阵\n正文');const capabilities={dir,state:{vaultPath:root}};let defaultModel={provider:'chat',id:'chat-model'};
  const chosen={provider:'overview',id:'chosen-model'},other={provider:'overview',id:'other-model'};let release,firstSignal;const seen=[];
  const task=new VaultOverview({capabilities,model:()=>defaultModel,send(){},runtime:async()=>({completeSimple:async(m,_ctx,options)=>{
    seen.push({id:m.id,reasoning:options.reasoning});if(m.id==='chosen-model'&&!release)return new Promise(resolve=>{release=()=>resolve({stopReason:'aborted',content:[]});firstSignal=options.signal;options.signal.addEventListener('abort',release,{once:true});});
    return {stopReason:'stop',content:[{type:'text',text:`摘要 ${m.id}`} ]};
  }})});
  const first=task.start({model:chosen,reasoning:'medium'});while(!release)await new Promise(r=>setTimeout(r,5));
  defaultModel={provider:'chat',id:'changed-during-task'};
  const second=task.start({model:other,reasoning:'low'});assert.equal(firstSignal.aborted,true);await Promise.all([first,second]);
  assert.ok(seen.some(item=>item.id==='chosen-model'&&item.reasoning==='medium'));
  assert.ok(seen.some(item=>item.id==='other-model'&&item.reasoning==='low'));
  assert.equal(seen.some(item=>item.id==='changed-during-task'),false);
  assert.match(await readFile(join(root,OVERVIEW_FILE),'utf8'),/overview\/other-model/);
}));

test('切换总览模型等待旧请求结束时立即显示停止状态',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'note.md'),'# 矩阵\n正文');const events=[];let release,activeCalls=0;
  const task=new VaultOverview({capabilities:{state:{vaultPath:root}},model,send:event=>events.push(event),runtime:async()=>({completeSimple:async(selected,_context,options)=>{
    activeCalls++;if(selected.id==='overview'&&!release)return new Promise(resolve=>{release=()=>resolve({stopReason:'aborted',content:[]});options.signal.addEventListener('abort',release,{once:true});});
    return {stopReason:'stop',content:[{type:'text',text:'完成'}]};
  }})});
  const first=task.start({model:{provider:'test',id:'overview'}});while(!release)await new Promise(r=>setTimeout(r,5));
  const next=task.start({model:{provider:'test',id:'next'}});assert.equal(task.snapshot().state,'stopping');assert.match(task.snapshot().message,/正在停止旧总览/);assert.equal(activeCalls,1);
  release();await Promise.all([first,next]);assert.equal(task.snapshot().state,'ready');
}));

test('相同模型和档位的并发启动复用任务，不同档位隔离检查点',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'note.md'),'# 矩阵\n正文');let calls=0,release;const capabilities={dir,state:{vaultPath:root}};
  const task=new VaultOverview({capabilities,model,send(){},runtime:async()=>({completeSimple:async(_m,_ctx,options)=>{calls++;if(calls===1)return new Promise(resolve=>{release=()=>resolve({stopReason:'aborted',content:[]});options.signal.addEventListener('abort',release,{once:true});});return {stopReason:'stop',content:[{type:'text',text:'完成'}]};}})});
  const a=task.start({reasoning:'low'});while(!release)await new Promise(r=>setTimeout(r,5));const b=task.start({reasoning:'low'});assert.equal(calls,1,'同一模型档位的并发启动不应再请求服务');task.cancel();await Promise.all([a,b]);
  const restarted=new VaultOverview({capabilities,model,send(){},runtime:async()=>({completeSimple:async(_m,_ctx,options)=>{assert.equal(options.reasoning,'medium');calls++;return {stopReason:'stop',content:[{type:'text',text:'新档位完成'}]};}})});
  await restarted.start({reasoning:'medium'});assert.equal(restarted.snapshot().state,'ready');assert.equal(calls,3);
}));

test('总览全批次固定启动时解析的凭据，凭据不进入状态事件',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'note.md'),'# 矩阵\n正文');let authReads=0;const events=[];const capabilities={state:{vaultPath:root}};
  const task=new VaultOverview({capabilities,model,send:event=>events.push(event),runtime:async()=>({
    getAuth:async(_selected,{signal})=>{assert.equal(signal.aborted,false);authReads++;return {auth:{apiKey:'ephemeral-token',headers:{'x-test':'captured'},baseUrl:'https://example.invalid'},env:{REGION:'captured'}};},
    completeSimple:async(_selected,_context,options)=>{assert.equal(options.apiKey,'ephemeral-token');assert.equal(options.headers['x-test'],'captured');assert.equal(options.env.REGION,'captured');return {stopReason:'stop',content:[{type:'text',text:'摘要'}]};}
  })});
  await task.start();assert.equal(authReads,1);assert.equal(task.snapshot().state,'ready');assert.equal(JSON.stringify(events).includes('ephemeral-token'),false);
}));

test('失联目录和空总览报错而不触发重新生成',()=>fixture(async(dir,root)=>{
  const caps={state:{vaultPath:join(root,'missing')}};let calls=0;
  const task=new VaultOverview({capabilities:caps,model,runtime:async()=>{calls++;throw Error('不得调用');},send(){}});
  await task.ensure();assert.equal(task.snapshot().state,'error');assert.match(task.snapshot().message,/不会自动重新生成/);
  caps.state.vaultPath=root;await writeFile(join(root,OVERVIEW_FILE),'');await task.ensure();assert.equal(task.snapshot().state,'error');assert.equal(calls,0);
}));

test('五篇分页完整无重叠，排除总览和不可读笔记',()=>fixture(async(dir,root)=>{
  for(let i=0;i<12;i++)await writeFile(join(root,`note-${String(i).padStart(2,'0')}.md`),`# 笔记 ${i}\n矩阵正文`);
  await writeFile(join(root,OVERVIEW_FILE),'矩阵总览');const caps=new CapabilityStore(dir);caps.state.vaultPath=root;caps.canRead=async p=>!p.endsWith('note-11.md');
  const a=await caps.browseNotes(),b=await caps.browseNotes(a.next),c=await caps.browseNotes(b.next);
  assert.deepEqual([a.results.length,b.results.length,c.results.length],[5,5,1]);assert.equal(c.next,null);assert.equal(new Set([...a.results,...b.results,...c.results].map(i=>i.path)).size,11);
  assert.ok((await caps.searchNotes('矩阵')).every(i=>!i.title.includes('总览')));caps.close();
}));

test('切换笔记库后，旧目录延迟恢复不能覆盖新目录状态',()=>fixture(async(dir,root)=>{
  const other=join(dir,'other');await mkdir(other);await writeFile(join(root,OVERVIEW_FILE),'旧总览');await writeFile(join(other,OVERVIEW_FILE),'新总览');
  const caps={state:{vaultPath:root}},events=[];let release;
  const task=new VaultOverview({capabilities:caps,model,runtime:async()=>{throw Error('不得调用');},send:e=>events.push(e),readOverview:async path=>path.startsWith(root)?new Promise(r=>release=r):readFile(path,'utf8')});
  const old=task.start();while(!release)await new Promise(r=>setTimeout(r,5));task.cancel();caps.state.vaultPath=other;const next=task.start();release('旧总览');await Promise.all([old,next]);
  assert.equal(task.snapshot().path,join(other,OVERVIEW_FILE));assert.equal(events.at(-1).path,join(other,OVERVIEW_FILE));assert.equal(events.some(event=>event.path===join(root,OVERVIEW_FILE)),false,'旧目录延迟恢复不得发出状态事件');
}));

test('timeout explains preserved batches and retry resumes instead of restarting',()=>fixture(async(dir,root)=>{
  await writeFile(join(root,'note.md'),'# 矩阵\n正文');let calls=0;
  const capabilities={dir,state:{vaultPath:root}};
  const task=new VaultOverview({capabilities,model,send(){},runtime:async()=>({completeSimple:async(_m,_c,options)=>{calls++;assert.equal(options.requestTimeoutMs,300000);assert.equal(options.idleTimeoutMs,120000);assert.equal(options.signal.aborted,false);if(calls===2)return {stopReason:'error',errorMessage:'Request timed out.',content:[]};return {stopReason:'stop',content:[{type:'text',text:'note.md：矩阵'}]};}})});
  await task.ensure();assert.equal(task.snapshot().state,'error');assert.match(task.snapshot().message,/模型服务请求超时/);assert.match(task.snapshot().message,/已保存完成批次/);
  await task.ensure();assert.equal(calls,3);assert.equal(task.snapshot().state,'ready');
}));

// Six notes force three 6000-character batches; one failed batch must not lose
// the other two, and the retry must re-request only the missing batch.
const batchFixture=async(root,count=6)=>{for(let i=0;i<count;i++)await writeFile(join(root,`note-${i}.md`),`# 笔记 ${i}\n\n${'矩阵特征值内容'.repeat(300)}`);};

test('单个批次失败不丢弃其他批次，重试只补齐失败批次',()=>fixture(async(dir,root)=>{
  await batchFixture(root);const capabilities={dir,state:{vaultPath:root}};const first=[],second=[];let run=1,fail=0;
  const text=context=>context.messages[0].content[0].text;
  const runtime=async()=>({completeSimple:async(_m,context)=>{
    if(run===1){first.push(text(context));if(first.length===2){fail++;return {stopReason:'error',errorMessage:'Request timed out.',content:[]};}return {stopReason:'stop',content:[{type:'text',text:`摘要 ${first.length}`}]};}
    second.push(text(context));return {stopReason:'stop',content:[{type:'text',text:'补齐摘要'}]};
  }});
  const task=new VaultOverview({capabilities,model,send(){},runtime});
  await task.ensure();
  assert.equal(fail,1);assert.equal(first.length,4,'三批摘要加一次汇总');
  assert.equal(task.snapshot().state,'ready','一个批次失败后仍生成总览');
  assert.equal(task.snapshot().failed,1);
  const written=await readFile(join(root,OVERVIEW_FILE),'utf8');assert.match(written,/1 批笔记本轮未完成摘要/);
  assert.match(written,/补齐|摘要/);
  await rm(join(root,OVERVIEW_FILE));
  run=2;const restarted=new VaultOverview({capabilities,model,send(){},runtime});
  await restarted.ensure();
  assert.equal(second.length,2,'重试只请求失败批次和最终汇总');
  assert.equal(second[0],first[1],'重试请求的正是失败的那一批');
  assert.equal(restarted.snapshot().state,'ready');
  assert.equal(restarted.snapshot().failed,0);
}));

test('压缩阶段失败仍产出总览并标注未完整覆盖',()=>fixture(async(dir,root)=>{
  await batchFixture(root);const capabilities={dir,state:{vaultPath:root}};let calls=0;
  const runtime=async()=>({completeSimple:async(_m,context)=>{calls++;const input=context.messages[0].content[0].text;
    if(calls<=3)return {stopReason:'stop',content:[{type:'text',text:'批'.repeat(6000)}]};
    if(calls===4)return {stopReason:'error',errorMessage:'Request timed out.',content:[]};
    return {stopReason:'stop',content:[{type:'text',text:'压缩后的总览正文'}]};}});
  const task=new VaultOverview({capabilities,model,send(){},runtime});
  await task.ensure();
  assert.ok(calls>=5,'压缩失败后仍继续汇总');
  assert.equal(task.snapshot().state,'ready');
  const written=await readFile(join(root,OVERVIEW_FILE),'utf8');
  assert.match(written,/压缩后的总览正文/);
  assert.match(written,/最终汇总只读取了部分摘要/);
}));

// The provider's parallel setting decides how many batches are understood at the
// same time; without it the run must stay strictly sequential.
const overlapFixture=async(root,{limit,notes=6})=>{
  for(let i=0;i<notes;i++)await writeFile(join(root,`note-${i}.md`),`# 笔记 ${i}\n\n${'矩阵特征值内容'.repeat(300)}`);
  let active=0,peak=0,calls=0;
  const runtime=async()=>({completeSimple:async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,60));active--;return {stopReason:'stop',content:[{type:'text',text:`摘要 ${calls}`}]};}});
  const task=new VaultOverview({capabilities:{dir:undefined,state:{vaultPath:root}},model,send(){},runtime,parallelLimit:()=>limit});
  return {task,stats:()=>({active,peak,calls})};
};

test('提供商开启并行时多个批次重叠请求，未开启时严格串行',()=>fixture(async(dir,root)=>{
  const parallel=await overlapFixture(root,{limit:3});
  await parallel.task.ensure();
  assert.equal(parallel.task.snapshot().state,'ready');
  assert.equal(parallel.stats().peak,3,'并行设置下的批次必须重叠请求');
  assert.ok(parallel.task.snapshot().concurrency===undefined||parallel.task.snapshot().concurrency===3);
  const written=await readFile(join(root,OVERVIEW_FILE),'utf8');
  assert.match(written,/批次理解并发：3/);
}));

test('未开启并行（并发 1）时逐批串行且行为不变',()=>fixture(async(dir,root)=>{
  const serial=await overlapFixture(root,{limit:1});
  await serial.task.ensure();
  assert.equal(serial.task.snapshot().state,'ready');
  assert.equal(serial.stats().peak,1,'未开启并行时同一时刻只能有一个批次请求');
  const written=await readFile(join(root,OVERVIEW_FILE),'utf8');
  assert.doesNotMatch(written,/批次理解并发/);
}));

test('阶段提示不累积，进度单调递增到 100%',()=>fixture(async(dir,root)=>{
  await batchFixture(root);const capabilities={dir,state:{vaultPath:root}};const events=[];
  const runtime=async()=>({completeSimple:async(_m,_context,options)=>{
    for(const phase of ['connecting','headers','first_body','finished'])options.onRequestState({state:'running',phase,elapsedMs:1,queuedMs:0});
    return {stopReason:'stop',content:[{type:'text',text:'批次摘要'}]};
  }});
  const task=new VaultOverview({capabilities,model,send:event=>events.push(event),runtime});
  await task.ensure();
  assert.equal(task.snapshot().state,'ready');
  const progressEvents=events.filter(event=>event.type==='vault_overview');
  const phases=progressEvents.filter(event=>event.phase&&event.phase!=='running');
  assert.ok(phases.length>=4,'每个阶段都要有进度事件');
  for(const event of phases){
    assert.ok(event.message.length<90,`阶段提示必须简短而不是累积：${event.message}`);
    assert.equal((event.message.match(/（/g)||[]).length,1,`阶段提示只能有一层括号：${event.message}`);
    assert.doesNotMatch(event.message,/本次数据接收完成.*本次数据接收完成/);
  }
  const values=progressEvents.map(event=>event.progress).filter(Number.isFinite);
  assert.ok(values.length>=3);
  for(let i=1;i<values.length;i++)assert.ok(values[i]>=values[i-1],`进度不得回退：${values.join(',')}`);
  assert.equal(progressEvents.at(-1).state,'ready');
  assert.equal(progressEvents.at(-1).progress,1);
  assert.ok(values.includes(0.03),'扫描阶段要有起始进度');
}));

test('并行下单个批次失败仍只补齐该批次，检查点不被并发写坏',()=>fixture(async(dir,root)=>{
  for(let i=0;i<6;i++)await writeFile(join(root,`note-${i}.md`),`# 笔记 ${i}\n\n${'矩阵特征值内容'.repeat(300)}`);
  const texts=[],failures=new Set();
  let active=0,peak=0;
  const runtime=async()=>({completeSimple:async(_m,context)=>{const input=context.messages[0].content[0].text;texts.push(input);const order=texts.length;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,40));active--;
    if(order===2&&!failures.has(input)){failures.add(input);return {stopReason:'error',errorMessage:'Request timed out.',content:[]};}
    return {stopReason:'stop',content:[{type:'text',text:`摘要 ${order}`}]};}});
  const task=new VaultOverview({capabilities:{dir,state:{vaultPath:root}},model,send(){},runtime,parallelLimit:()=>2});
  await task.ensure();
  assert.equal(task.snapshot().state,'ready');assert.equal(task.snapshot().failed,1);assert.ok(peak>1,'并发必须实际发生');
  await rm(join(root,OVERVIEW_FILE));
  const saved=JSON.parse(await readFile(join(dir,'vault-progress',(await readdir(join(dir,'vault-progress')))[0]),'utf8'));
  assert.equal(Object.keys(saved.results).length,2,'并发下两个成功批次都必须写入同一个完整检查点');
  assert.equal(Object.keys(saved.failed).length,1);
  const before=texts.length;
  const retry=new VaultOverview({capabilities:{dir,state:{vaultPath:root}},model,send(){},runtime,parallelLimit:()=>2});
  await retry.ensure();
  assert.equal(retry.snapshot().state,'ready');assert.equal(retry.snapshot().failed,0);
  assert.equal(texts.length-before,2,'重试只请求失败批次和最终汇总');
}));
