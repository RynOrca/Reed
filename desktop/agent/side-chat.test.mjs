import test from 'node:test';
import assert from 'node:assert/strict';
import {Type} from '@earendil-works/pi-ai';
import {createSideChat,mainChatReference} from './side-chat.mjs';
const message=(content,stopReason='stop')=>({role:'assistant',content,stopReason,timestamp:1});
const text=value=>({type:'text',text:value});
const reply=value=>({async *[Symbol.asyncIterator](){for(const block of value.content)if(block.type==='text')yield {type:'text_delta',delta:block.text};},result:async()=>value});
const read=execute=>({name:'read',description:'只读合成文件',parameters:Type.Object({path:Type.String()}),execute});

test('侧边文本以完整响应校准丢失的符号并隔开工具前后正文',async()=>{
  const events=[];let step=0;
  const chat=createSideChat({emit:e=>events.push(e),selectModel:()=>({id:'test'}),workspace:()=>'/test',readTool:()=>read(async()=>({content:[text('合成资料')]})),stream:async()=>{
    const value=++step===1?message([text('先解释 **概念**：a < b。'),{type:'toolCall',id:'read-one',name:'read',arguments:{path:'test.txt'}}],'toolUse'):message([text('然后说明 $x_i + 1$。')]);
    return {async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:step===1?'先解释 概念：a b。':'然后说明 xi 1。'};},result:async()=>value};
  }});
  await chat.prompt({id:'text',text:'合成问题'});
  assert.equal(events.at(-1).state,'done');
  assert.equal(events.findLast(e=>e.state==='text').text,'先解释 **概念**：a < b。\n\n然后说明 $x_i + 1$。');
});

test('主会话参考含摘要、正文和学习图解，排除思考、图片及其他工具结果',()=>{
  const reference=mainChatReference([
    {role:'compactionSummary',summary:'早先讨论贝叶斯公式'},
    {role:'user',content:'解释先验'},
    {role:'assistant',stopReason:'toolUse',content:[text('先验是先前的判断'),{type:'thinking',thinking:'隐藏思考'},{type:'toolCall',name:'write',arguments:{path:'禁止执行'}}]},
    {role:'toolResult',toolName:'read',content:[text('无关工具原文')]},
    {role:'toolResult',toolName:'show_learning',content:[text('图解')],details:{learning:{fallbackText:'先验到后验',blocks:[{type:'callout',text:'贝叶斯公式'}]}}},
  ]);
  assert.match(reference,/早先讨论贝叶斯公式/);assert.match(reference,/先验是先前的判断/);assert.match(reference,/贝叶斯公式/);
  assert.doesNotMatch(reference,/隐藏思考|禁止执行|无关工具原文/);
  const bounded=mainChatReference([{role:'user',content:'引号"与换行\n'.repeat(10000)}],2000);
  assert.ok(bounded.length<=2000);assert.match(bounded,/截短/);assert.doesNotThrow(()=>JSON.parse(bounded));
});

test('每轮刷新主会话参考，不累积旧快照，切换会话隔离侧边追问',async()=>{
  let main={sessionId:'main-a',messages:[{role:'user',content:'主对话第一题'}]};const seen=[];
  const chat=createSideChat({mainContext:()=>main,selectModel:()=>({id:'test',contextWindow:32000}),workspace:()=>'/test',emit:()=>{},readTool:()=>read(()=>{}),stream:async(_m,c)=>{seen.push(structuredClone(c));return reply(message([text('侧边答案')]));}});
  await chat.prompt({id:'one',text:'第一题追问'});
  main.messages.push({role:'assistant',content:[text('主对话新增答案')],stopReason:'stop'});
  await chat.prompt({id:'two',text:'继续追问'});
  assert.match(seen[1].messages[0].content,/主对话新增答案/);
  assert.equal(seen[1].messages.filter(m=>typeof m.content==='string'&&m.content.includes('以下是当前主对话')).length,1);
  assert.ok(seen[1].messages.some(m=>m.content==='第一题追问'));
  main={sessionId:'main-b',messages:[{role:'user',content:'另一个主会话'}]};
  await chat.prompt({id:'three',text:'新追问'});
  assert.equal(seen[2].messages.length,2);assert.doesNotMatch(JSON.stringify(seen[2]),/第一题追问|主对话第一题/);
});

test('侧边聊天仅开放 read，连续对话保存在内存，reset 后不带旧记录',async()=>{
  const seen=[],events=[],calls=[];
  const chat=createSideChat({selectModel:()=>({id:'synthetic'}),workspace:()=>'/test',emit:e=>events.push(e),readTool:()=>read(async(id,args)=>{calls.push(args);return {content:[text('合成笔记')]};}),stream:async(model,context,options)=>{
    seen.push({context:structuredClone(context),sessionId:options.sessionId});
    assert.deepEqual(context.tools.map(t=>t.name),['read']);
    return reply(seen.length===1?message([{type:'toolCall',id:'read-1',name:'read',arguments:{path:'test-note.md'}}],'toolUse'):message([text('合成回答')]));
  }});
  await chat.prompt({id:'one',text:'读合成文件'});assert.equal(calls.length,1);assert.equal(seen[1].context.messages.at(-1).role,'toolResult');
  await chat.prompt({id:'two',text:'再解释'});assert.equal(seen[2].context.messages.length,5);assert.equal(seen[0].sessionId,seen[2].sessionId);
  chat.reset();await chat.prompt({id:'three',text:'新的临时聊天'});assert.equal(seen[3].context.messages.length,1);assert.notEqual(seen[3].sessionId,seen[0].sessionId);assert.equal(events.filter(e=>e.state==='done').length,3);
});

test('侧边拒绝未授权工具及无效 read 参数，失败不进入下一次上下文',async()=>{
  for(const call of [{name:'write',arguments:{path:'test'}},{name:'read',arguments:{}}]){
    const events=[],seen=[];let reads=0;
    const chat=createSideChat({selectModel:()=>({id:'test'}),workspace:()=>'/test',emit:e=>events.push(e),readTool:()=>read(async()=>{reads++;}),stream:async(_m,c)=>{seen.push(structuredClone(c));return reply(seen.length===1?message([{type:'toolCall',id:'bad',...call}],'toolUse'):message([text('第二次正常')]));}});
    await chat.prompt({id:'bad',text:'合成'});assert.equal(events.at(-1).state,'error');assert.equal(reads,0);
    await chat.prompt({id:'next',text:'重试'});assert.equal(seen[1].messages.length,1);
  }
});

test('侧边请求拥有独立控制器，reset 丢弃晚到事件且不阻止下一次请求',async()=>{
  let release;const blocked=new Promise(r=>release=r),events=[],signals=[];
  const chat=createSideChat({selectModel:()=>({id:'test'}),workspace:()=>'/test',emit:e=>events.push(e),readTool:()=>read(()=>{}),stream:async(_m,_c,options)=>{
    signals.push(options.signal);if(signals.length===1)await blocked;return reply(message([text('合成')]));
  }});
  const old=chat.prompt({id:'old',text:'旧请求'});assert.equal(chat.busy,true);
  await assert.rejects(chat.prompt({id:'duplicate',text:'并发侧边请求'}),/正在回复/);
  chat.reset();assert.equal(signals[0].aborted,true);await chat.prompt({id:'new',text:'新请求'});release();await old;
  assert.equal(events.filter(e=>e.id==='old'&&e.state!=='started').length,0);assert.equal(events.at(-1).id,'new');
});
