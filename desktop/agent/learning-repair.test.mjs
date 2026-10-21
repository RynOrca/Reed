import test from 'node:test';
import assert from 'node:assert/strict';
import {createLearningRepair} from './learning-repair.mjs';
import {learningBlockExtension,learningSpecSchema,prepareLearningArguments} from './learning-blocks.mjs';
const valid={schemaVersion:1,fallbackText:'完整文字',blocks:[{id:'diagram',type:'callout',title:'条件',text:'合成条件',fallbackText:'合成条件'}]};
const broken={schemaVersion:1,blocks:valid.blocks};
function fixture(fn){const session={model:{id:'mock'},sessionId:'test'},requests=[];
  const state=createLearningRepair({currentSession:()=>session,runtime:async()=>({completeSimple:async(...args)=>{requests.push(args);return fn(requests.length,...args);}}),schema:learningSpecSchema,validate:prepareLearningArguments});return {state,session,requests};}
const response=value=>({stopReason:'stop',content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
test('缺失字段诊断经内部模型修正，第三次成功；不发送完整会话或工具',async()=>{
  const {state,requests}=fixture(n=>response(n<3?broken:valid));
  assert.deepEqual(await state.repair(broken,Error('root: 学习内容缺少 fallbackText')),valid);
  assert.equal(requests.length,3);
  const first=requests[0];assert.equal(first[1].messages.length,1);assert.equal(first[1].tools,undefined);
  assert.match(first[1].messages[0].content[0].text,/root.*fallbackText/);assert.equal(first[2].reasoning,'off');
});
test('三次均失败后无第四次请求；新轮次恢复预算',async()=>{
  const {state,requests}=fixture(()=>response('invalid JSON'));
  assert.equal(await state.repair(broken,Error('missing')),null);assert.equal(requests.length,3);
  assert.equal(await state.repair(broken,Error('missing')),null);assert.equal(requests.length,3);
  state.reset();await state.repair(broken,Error('missing'));assert.equal(requests.length,6);
});
test('取消及轮次重置不发布晚到的成功图解',async()=>{
  const abort=new AbortController();const a=fixture(()=>{abort.abort();return response(valid);});
  await assert.rejects(a.state.repair(broken,Error('missing'),abort.signal),{name:'AbortError'});assert.equal(a.requests.length,1);
  let release,started;const ready=new Promise(r=>started=r);
  const b=fixture(()=>{started();return new Promise(r=>release=r);});
  const pending=b.state.repair(broken,Error('missing'));await ready;b.state.reset();release(response(valid));assert.equal(await pending,null);
});
test('SDK校验前的传输信封不当作回执，执行时才修正；失败仅向模型请求转文字',async()=>{
  let calls=0,tool;const selected={model:{id:'mock'}};
  learningBlockExtension({currentSession:()=>selected,runtime:async()=>({completeSimple:async()=>{calls++;return response(valid);}})})({on(){},registerTool:t=>tool=t});
  const prepared=tool.prepareArguments(broken);assert.doesNotThrow(()=>prepareLearningArguments(prepared));
  const result=await tool.execute('id',prepared);assert.equal(calls,1);assert.deepEqual(result.details.learning,valid);
  learningBlockExtension()({on(){},registerTool:t=>tool=t});
  const failed=await tool.execute('id',tool.prepareArguments(broken));assert.equal(failed.details.learning,undefined);assert.equal(failed.details.learningFallback,true);assert.match(failed.content[0].text,/普通文本/);
});
