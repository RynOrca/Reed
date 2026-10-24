import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleContext,resolveTask} from './context-assembler.mjs';
const model={contextWindow:32000,maxTokens:4096};
test('统一资料额度去重，低预算不挤占当前问题',()=>{
  const packet=assembleContext([{id:'a',kind:'note',text:'同一段证据',priority:2},{id:'b',kind:'pdf',text:'同一段证据',priority:3}],{model});
  assert.equal(packet.report.items.length,1);assert.equal(packet.report.items[0].id,'b');
  const full=assembleContext([{id:'a',text:'额外资料'}],{model,messages:[{role:'user',content:'问'.repeat(40000)}]});
  assert.equal(full.text,null);assert.equal(full.report.referenceTokens,0);
  assert.throws(()=>assembleContext([{id:'a',text:'长'.repeat(10000),required:true}],{model}),/缩小选区/);
});
test('短指代跟随阅读锚点，显式报错问题摆脱旧教材',()=>{
  const scene={readingVisible:true,capturedAt:Date.now(),selectionText:'贝叶斯公式'};
  assert.equal(resolveTask('这一步为什么？',[],scene).anchor,true);
  assert.equal(resolveTask('帮我修复 npm 代码报错',[],scene).anchor,false);
  assert.equal(resolveTask('你好',[],scene).greeting,true);
  assert.equal(resolveTask('解释这里',[],{...scene,capturedAt:0}).anchor,false);
});
