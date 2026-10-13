import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCustomExample} from './custom-examples.mjs';
import {validateDocument,validateState} from './protocol.mjs';
import {validCustomTree} from '../../web/custom-contract.mjs';
import {validateCustomRuntime} from './custom-validation.mjs';
import {reviewCustomDocument,REVIEW_DEFAULT,validateReviewSettings} from './reviewer.mjs';
import {InteractiveArtifactStore} from './artifacts.mjs';
import {createInteractiveGeneration,INTERACTIVE_TOOL} from './generation.mjs';

test('自定义协议拒绝额外字段、非法状态和危险图形属性；作品保存源码/质量/状态版本',async()=>{
  const doc=createCustomExample();validateDocument(doc);assert.throws(()=>validateDocument({...doc,sdkVersion:2}),/无效/);assert.throws(()=>validateDocument({...doc,html:'x'}),/无效/);
  assert.ok(!validateState(doc,{...doc.initialState,x:Infinity}));assert.ok(!validateState(doc,{...doc.initialState,extra:1}));
  assert.ok(validCustomTree({type:'svg',viewBox:'0 0 100 100',children:[{type:'path',d:'M0 0L10 10',stroke:'#8dcaf0'}]}));
  for(const tree of [{type:'iframe',src:'https://x'},{type:'text',text:'hello',innerHTML:'<script>'},{type:'svg',viewBox:'0 0 100 100',children:[{type:'circle',cx:0,cy:0,r:5,onload:'x'}]},{type:'svg',viewBox:'0 0 0 0',children:[]},{type:'svg',viewBox:'0 0 100 100',children:[{type:'circle',r:4,fill:'url(https://x)'}]}])assert.equal(validCustomTree(tree),false);
  const root=await mkdtemp(join(tmpdir(),'reed-custom-store-'));try{const store=new InteractiveArtifactStore(root),session=randomUUID(),quality={facts:'unverified',review:{enabled:false}},artifact=await store.create(session,doc,{quality}),state={x:4.4,rate:.1,step:1};await store.saveState(session,artifact.artifactId,state);const recovered=await new InteractiveArtifactStore(root).read(session,artifact.artifactId);assert.deepEqual(recovered.state,state);assert.equal(recovered.document.script,doc.script);assert.deepEqual(recovered.quality,quality);}finally{await rm(root,{recursive:true,force:true});}
});

test('真实隔离沙箱运行三份自定义示例，独立核对计算；无DOM/宿主/网络；死循环可终止',async()=>{
  const gradient=await validateCustomRuntime(createCustomExample('gradient'));assert.equal(gradient.snapshots[0].x,4.4);assert.equal(gradient.snapshots[2].x,2);
  const queue=await validateCustomRuntime(createCustomExample('queue'));assert.deepEqual(queue.snapshots[0].items,[2]);assert.equal(queue.snapshots[0].head,1);assert.deepEqual(queue.snapshots[1].items,[2,3]);
  const policy=await validateCustomRuntime(createCustomExample('policy'));assert.equal(policy.snapshots[0].q0,2);assert.equal(policy.snapshots[1].temperature,3);
  const isolated={...createCustomExample(),stateSchema:{safe:{type:'boolean'}},initialState:{safe:false},script:`Reed.register({render:s=>ui.text('隔离='+s.safe),reduce:s=>({safe:typeof window==='undefined'&&typeof document==='undefined'&&typeof process==='undefined'&&typeof fetch==='undefined'&&typeof Worker==='undefined'&&typeof importScripts==='undefined'&&typeof self.__TAURI__==='undefined'})});`,checks:[{action:'probe'}]};
  assert.equal((await validateCustomRuntime(isolated)).snapshots[0].safe,true);
  await assert.rejects(validateCustomRuntime({...createCustomExample(),script:'while(true){}',checks:[]}),/1500|失败/);
  await assert.rejects(validateCustomRuntime({...createCustomExample(),script:'Reed.register({render:()=>ui.text("ok"),reduce:()=>({})});'}),/状态|失败/);
  await assert.rejects(validateCustomRuntime({...createCustomExample(),script:'Reed.register({'}),/Unexpected|预期/);
});

test('独立审核默认不调用模型；使用独立模型档位且无需手填maxTokens；拒绝/截断/无效输出不发布',async()=>{
  const document=createCustomExample(),validation={status:'passed'},settings={enabled:true,provider:'review-provider',modelId:'review-model',reasoning:'low'};
  let called=0,last;
  const runtime=async()=>({getModel:(p,id)=>({provider:p,id,contextWindow:100000,maxTokens:4096}),completeSimple:async(model,context,options)=>{called++;last={model,context,options};return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({verdict:'pass',summary:'已审核，未见实质问题',issues:[]})}]};}});
  assert.deepEqual(await reviewCustomDocument({document,validation,settings:REVIEW_DEFAULT,runtime:()=>{throw Error('不应调用');}}),{enabled:false});
  const result=await reviewCustomDocument({document,validation,settings,runtime});assert.equal(called,1);assert.equal(result.modelId,'review-model');assert.equal(last.options.reasoning,'low');assert.ok(!Object.hasOwn(last.options,'maxTokens'));assert.ok(!Object.hasOwn(last.context,'tools'));
  for(const response of [{stopReason:'length',content:[]},{stopReason:'stop',content:[{type:'text',text:'not json'}]},{stopReason:'stop',content:[{type:'text',text:JSON.stringify({verdict:'revise',summary:'公式错误',issues:['导数错误']})}]}])await assert.rejects(reviewCustomDocument({document,validation,settings,runtime:async()=>({...await runtime(),completeSimple:async()=>response})}),/审核/);
  assert.throws(()=>validateReviewSettings({...settings,enabled:'yes'}),/无效/);assert.throws(()=>validateReviewSettings({...settings,modelId:''}),/请选择/);
});

test('自定义生成先试运行再审核后发布；失败无作品；有限修正；资料工具权限与白名单',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-custom-tool-'));try{
    const role={interactiveUiEnabled:true},tools=[],events=[],branch=[{id:'owner',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'call',name:INTERACTIVE_TOOL}]}}],session={sessionId:randomUUID(),sessionManager:{getBranch:()=>branch,appendCustomEntry:(customType,data)=>branch.push({type:'custom',customType,data})}};
    const order=[],store=new InteractiveArtifactStore(root);let fail=true;
    const generation=await createInteractiveGeneration({roles:{current:()=>role},currentSession:()=>session,store,send:e=>events.push(e),validateRuntime:async()=>{order.push('runtime');return {status:'passed'};},reviewer:async()=>{order.push('review');if(fail)throw new Error('审核要求修正');return {enabled:true};}});
    generation.extension({on(){},registerTool:t=>tools.push(t)});const generate=tools.find(t=>t.name===INTERACTIVE_TOOL),reference=tools.find(t=>t.name==='get_interactive_reference'),input={document:JSON.stringify(createCustomExample())};
    await assert.rejects(generate.execute('call',input),/审核/);assert.equal(events.length,0);assert.equal(branch.length,1);fail=false;await generate.execute('call',input);assert.deepEqual(order,['runtime','review','runtime','review']);assert.equal(events.length,1);
    const artifact=await store.read(session.sessionId,events[0].summary.artifactId);assert.equal(artifact.quality.facts,'unverified');
    await generate.execute('call',input);await assert.rejects(generate.execute('call',input),/三次/);
    assert.match((await reference.execute('ref',{topic:'sdk'})).content[0].text,/Reed.register/);await assert.rejects(reference.execute('ref',{topic:'../../key'}),/未知/);
    role.interactiveUiEnabled=false;await assert.rejects(reference.execute('ref',{topic:'sdk'}),/未启用/);await assert.rejects(generate.execute('call',input),/未启用/);
  }finally{await rm(root,{recursive:true,force:true});}
});
