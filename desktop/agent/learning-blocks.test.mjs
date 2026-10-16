import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLearningSpec,learningReceipt,latestLearningQuestion,validateLearningReply,learningReplyText,learningBlockExtension} from './learning-blocks.mjs';
const question={id:'q',type:'choices',title:'gcd 返回 3 时会进入分支吗？',fallbackText:'请说明非零整数的真值。',options:[{id:'yes',label:'会',replyText:'会，非零整数为真。'},{id:'unsure',label:'不确定',replyText:'我还不确定。'}]};
const spec={schemaVersion:1,fallbackText:'判断的是非零整数。',blocks:[question]};
const result={role:'toolResult',toolName:'show_learning',toolCallId:'call-1',details:{learning:spec}};
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
