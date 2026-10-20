import test from 'node:test';
import assert from 'node:assert/strict';
import {runToolCall} from '@earendil-works/pi-agent-core';
import {validateToolArguments} from '@earendil-works/pi-ai';
import {validateLearningSpec,prepareLearningArguments,learningReceipt,latestLearningQuestion,validateLearningReply,learningReplyText,learningBlockExtension} from './learning-blocks.mjs';
const question={id:'q',type:'choices',title:'gcd 返回 3 时会进入分支吗？',fallbackText:'请说明非零整数的真值。',options:[{id:'yes',label:'会',replyText:'会，非零整数为真。'},{id:'unsure',label:'不确定',replyText:'我还不确定。'}]};
const spec={schemaVersion:1,fallbackText:'判断的是非零整数。',blocks:[question]};
const result={role:'toolResult',toolName:'show_learning',toolCallId:'call-1',details:{learning:spec}};

const registeredTool=()=>{let tool;learningBlockExtension()({registerTool:value=>tool=value,on(){}});return tool;};
const runLearning=async(argumentsValue)=>{
  const tool=registeredTool(),call={type:'toolCall',id:'regression',name:tool.name,arguments:argumentsValue};
  return runToolCall(call,{assistantMessage:{role:'assistant',content:[call]},context:{messages:[],tools:[tool]},signal:new AbortController().signal});
};

test('真实 SDK 校验前补全 replyText-only 选项，回执仍能校验与作答',async()=>{
  const input={...spec,blocks:[{...question,options:[{replyText:'请先总结重点。'},{replyText:'我先自己阅读。'},{replyText:'直接进入下一阶段。'}]}]};
  const original=structuredClone(input);
  assert.throws(()=>validateToolArguments(registeredTool(),{name:'show_learning',arguments:input}));
  const output=await runLearning(input);
  assert.equal(output.isError,false);
  const receipt={...result,details:output.result.details};
  const restored=learningReceipt(receipt);assert.ok(restored);
  assert.deepEqual(input,original,'不修改模型原始参数与历史记录');
  assert.deepEqual(restored.blocks[0].options.map(o=>o.id),['choice-1','choice-2','choice-3']);
  assert.equal(restored.blocks[0].options[0].label,'请先总结重点。');
  const entries=[{id:'parent',message:{role:'user',content:'选一个'}},{message:receipt}];
  const option=restored.blocks[0].options[0];
  assert.equal(validateLearningReply(entries,'s',{sessionId:'s',toolCallId:receipt.toolCallId,blockId:'q',optionId:option.id},learningReplyText(restored.blocks[0],option)).optionId,option.id);
});

test('真实 SDK 兼容保留现有字段，生成 ID 避让，标签受长度限制',async()=>{
  const options=[{replyText:'甲'.repeat(300)},{id:'choice-1',label:'保留',replyText:'原始回复'}];
  const output=await runLearning({...spec,blocks:[{...question,options}]});
  assert.equal(output.isError,false);
  const actual=output.result.details.learning.blocks[0].options;
  assert.equal(actual[0].id,'choice-1-');assert.equal(actual[0].label.length,240);
  assert.equal(actual[0].replyText.length,300);assert.deepEqual(actual[1],options[1]);
  assert.deepEqual((await runLearning(spec)).result.details.learning,spec);
});

test('非法选项保留精确内部诊断，SDK无修正模型时请求转文本且不发布错误图解',async()=>{
  for(const [block,pattern] of [
    [{...question,options:[{replyText:''}]},/blocks\[0\]\.options\[0\]\.replyText/],
    [{...question,options:[{id:'a',label:'甲'}]},/blocks\[0\]\.options\[0\].*replyText/],
    [{...question,options:[{replyText:'甲',action:'write'}]},/options\[0\].*action/],
    [{...question,options:[{id:null,label:'甲',replyText:'甲'}]},/options\[0\]\.id/],
    [{...question,options:[]},/options/],
    [{...question,type:'script'},/type/],
    [{...question,options:[question.options[0],question.options[0]]},/选项 ID 必须唯一/],
  ]){
    const output=await runLearning({...spec,blocks:[block]});
    assert.throws(()=>prepareLearningArguments({...spec,blocks:[block]}),pattern);
    assert.equal(output.isError,false);assert.equal(output.result.details.learning,undefined);assert.equal(output.result.details.learningFallback,true);
    const message=output.result.content.map(b=>b.text||'').join('\n');assert.match(message,/普通文本/);assert.doesNotMatch(message,/Received arguments|root:|must have required properties nodes/);
  }
  assert.throws(()=>validateLearningSpec({...spec,blocks:[{...question,options:[{replyText:'甲'}]}]}),/缺少 id/,'历史回执不隐式补全');
});

test('内置规范完整 JSON 示例通过实际工具协议',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('./skills/learning-blocks/SKILL.md',import.meta.url),'utf8');
  const examples=[...source.matchAll(/```json\s*([\s\S]*?)```/g)].map(match=>JSON.parse(match[1])).filter(example=>example.blocks?.length);
  assert.ok(examples.length);
  for(const example of examples)assert.equal((await runLearning(example)).isError,false);
});
test('学习协议拒绝任意动作、重复题目、重复 ID 与半成品输入',()=>{
  assert.deepEqual(validateLearningSpec(spec),spec);
  assert.throws(()=>validateLearningSpec({...spec,blocks:[{...question,action:'write'}]}));
  assert.throws(()=>validateLearningSpec({...spec,blocks:[question,{...question,id:'other'}]}));
  assert.throws(()=>validateLearningSpec({...spec,blocks:[{...question,options:[question.options[0],question.options[0]]}]}));
  assert.throws(()=>validateLearningSpec({...spec,blocks:[{...question,options:[]}]}));
  assert.throws(()=>validateLearningSpec({...spec,schemaVersion:2}));
  assert.equal(learningReceipt({...result,isError:true}),null);
  assert.equal(learningReceipt({...result,details:undefined}),null);
});
test('快捷回复核对来源和原文，后续用户消息使旧题失效',()=>{
  const entries=[{message:{role:'user',content:'解释条件'}},{message:result}];
  const reply={sessionId:'s',toolCallId:'call-1',blockId:'q',optionId:'yes'};
  const text=learningReplyText(question,question.options[0]);
  assert.equal(latestLearningQuestion(entries).toolCallId,'call-1');
  assert.equal(validateLearningReply(entries,'s',reply,text).optionId,'yes');
  assert.throws(()=>validateLearningReply(entries,'other',reply,text));
  assert.throws(()=>validateLearningReply(entries,'s',{...reply,toolCallId:'fake'},text));
  assert.throws(()=>validateLearningReply(entries,'s',reply,'会')); 
  assert.throws(()=>validateLearningReply([...entries,{message:{role:'user',content:text}}],'s',reply,text));
});
test('工具生成可持久化回执，不把未执行的工具参数当学习内容',async()=>{
  let tool;learningBlockExtension()({registerTool:t=>tool=t,on(){}});
  const output=await tool.execute('c',spec,new AbortController().signal);
  assert.equal(output.content[0].text,spec.fallbackText);assert.deepEqual(output.details.learning,spec);
  const controller=new AbortController();controller.abort();
  await assert.rejects(tool.execute('c',spec,controller.signal));
  assert.equal(learningReceipt({role:'assistant',content:[{type:'toolCall',arguments:spec}]}),null);
});

test('填空提交保留输入语义和父问题来源，拒绝空白、篡改、超长及混合两题',()=>{
  const fill={id:'fill',type:'fill',title:'补全加法表达式',label:'c_sum =',fallbackText:'填写 c_sum 表达式。',multiline:true};
  const value={schemaVersion:1,fallbackText:'填写表达式。',blocks:[fill]};
  const entries=[{id:'parent',message:{role:'user',content:'练习同态加法'}},{id:'tool',message:{...result,details:{learning:value}}}];
  assert.deepEqual(validateLearningSpec(value),value);
  const reply={sessionId:'s',toolCallId:'call-1',blockId:'fill',answer:'(c1 * c2) % (n ** 2)'};
  const text=learningReplyText(fill,reply.answer);
  assert.equal(validateLearningReply(entries,'s',reply,text).parentUserId,'parent');
  assert.equal(validateLearningReply(entries,'s',reply,text).answer,reply.answer);
  for(const answer of ['', ' ', 'x'.repeat(2001)])assert.throws(()=>validateLearningReply(entries,'s',{...reply,answer},learningReplyText(fill,answer)));
  assert.throws(()=>validateLearningReply(entries,'s',reply,'篡改文字'));
  assert.throws(()=>validateLearningSpec({...value,blocks:[fill,question]}));
  assert.throws(()=>validateLearningSpec({...value,blocks:[{...fill,source:{label:'假来源',url:'javascript:alert(1)'}}]}));
  assert.throws(()=>validateLearningSpec({...value,blocks:[{...fill,multiline:'true'}]}));
});
