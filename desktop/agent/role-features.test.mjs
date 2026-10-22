import test from 'node:test';
import assert from 'node:assert/strict';
import {roleFeatureExtension} from './role-features.mjs';
import {createContextAssembler} from './context-assembler.mjs';

test('学习目标每轮刷新并独立于自动参考额度，关闭角色后清除',async()=>{
  const hooks={},reports=[];let enabled=true,body='CURRENT_GOAL_SENTINEL',reads=0;
  const pi={on:(name,hook)=>(hooks[name]??=[]).push(hook)};
  roleFeatureExtension({roles:{current:()=>({learningGoalsEnabled:enabled,learnerProfileEnabled:enabled})},goals:{section:async(project,on)=>{reads++;assert.equal(project,'test-project');return on?body:null;}},project:()=> 'test-project',memory:{},learner:{},currentSession:()=>({state:{messages:[]}}),managedContext:true})(pi);
  createContextAssembler({sources:async()=>[],send:e=>reports.push(e)})(pi);
  async function run(text){let event={messages:[{role:'system',content:'规则'},{role:'user',content:text}]};for(const hook of hooks.context_with_system)event=await hook(event,{model:{contextWindow:5000,maxTokens:4000}});return event.messages;}
  for(const text of ['这一步为什么？','你好','帮我检查 npm 报错']){
    assert.match(JSON.stringify(await run(text)),/CURRENT_GOAL_SENTINEL/);
    assert.equal(reports.at(-1).items[0].kind,'goal');assert.equal(reports.at(-1).automaticReferenceTokens,0);
  }
  body='UPDATED_GOAL_SENTINEL';assert.match(JSON.stringify(await run('继续')),/UPDATED_GOAL_SENTINEL/);
  enabled=false;const off=await run('继续');assert.doesNotMatch(JSON.stringify(off),/UPDATED_GOAL_SENTINEL/);assert.equal(reports.at(-1).items.length,0);assert.equal(reads,5);
});
