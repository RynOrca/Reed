import test from 'node:test';
import assert from 'node:assert/strict';
import {streamSimple,completeSimple} from '@earendil-works/pi-ai/compat';
import {withSenseNovaPayload,senseNovaPayload,senseNovaCompat} from './sensenova.mjs';
import {ProviderStore} from './providers.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const model={id:'sensenova-6.7-flash-lite',name:'SenseNova test',api:'openai-completions',provider:'test-sense',baseUrl:'https://token.sensenova.cn/v1',reasoning:true,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{thinkingFormat:'qwen',supportsStore:true,supportsReasoningEffort:true,supportsStrictMode:true}};
const context={systemPrompt:'合成系统指令',messages:[{role:'user',content:'合成测试，不含真实笔记',timestamp:Date.now()}]};
test('严格网关仅接收支持字段：前台流与后台 complete 均经过实际 SDK',async()=>{
  const seen=[];
  const request=async(_url,init)=>{
    const body=JSON.parse(init.body);seen.push(body);
    assert.ok(body.max_tokens>0);assert.ok(body.messages.every(m=>m.role!=='developer'));
    for(const key of Object.keys(body))assert.ok(['model','messages','stream','max_tokens','temperature','top_p','tools','tool_choice','stop'].includes(key),key);
    for(const tool of body.tools||[])assert.equal(tool.function.strict,undefined);
    const response={id:'test',object:'chat.completion.chunk',created:1,model:model.id,choices:[{index:0,delta:{content:'本地模拟通过'},finish_reason:'stop'}]};
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  };
  const options=withSenseNovaPayload(model,{apiKey:'test-only',reasoning:'medium',maxTokens:100,fetch:request});
  const stream=streamSimple(model,{...context,tools:[{name:'test_tool',description:'合成',parameters:{type:'object',properties:{},additionalProperties:false}}]},options);
  assert.equal((await stream.result()).stopReason,'stop');
  assert.equal((await completeSimple(model,context,options)).stopReason,'stop');assert.equal(seen.length,2);
});
test('移除旧思考回传及严格字段，保留工具调用 ID 和结果，其他供应商不受影响',async()=>{
  const payload={model:model.id,messages:[{role:'assistant',content:null,reasoning:'hidden',reasoning_content:'hidden',tool_calls:[{id:'call-1',type:'function',function:{name:'test',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'合成工具结果'}],tools:[{type:'function',function:{name:'test',strict:true,parameters:{type:'object'}}}],max_completion_tokens:100,response_format:{type:'json_object'},enable_thinking:false,store:false,stream_options:{include_usage:true}};
  const converted=senseNovaPayload(payload);assert.equal(converted.messages[0].tool_calls[0].id,'call-1');assert.equal(converted.messages[1].tool_call_id,'call-1');assert.equal(converted.messages[0].reasoning,undefined);assert.equal(converted.tools[0].function.strict,undefined);
  const options={onPayload:()=>payload};assert.equal(withSenseNovaPayload({...model,baseUrl:'https://example.com/v1'},options),options);
  const hook=withSenseNovaPayload(model,{onPayload:async p=>({...p,temperature:0.5,thinking:{type:'enabled'}})});assert.equal((await hook.onPayload(payload,model)).temperature,0.5);assert.equal((await hook.onPayload(payload,model)).thinking,undefined);
});
test('旧自定义商汤配置自动启用兼容参数，不要求重建提供商',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-test-sense-'));
  try{const store=new ProviderStore(root);store.providers=[{id:'old-custom',template:'custom',baseUrl:model.baseUrl,protocol:model.api,models:[{id:model.id,name:model.id,reasoning:true,compat:{thinkingFormat:'qwen'}}]}];
    await store.install({refresh:async()=>{},setRuntimeApiKey:async()=>{}});
    const saved=JSON.parse(await readFile(store.modelsPath,'utf8')).providers['old-custom'].models[0];assert.equal(saved.reasoning,false);
    for(const [key,value] of Object.entries(senseNovaCompat))assert.equal(saved.compat[key],value);
  }finally{await rm(root,{recursive:true,force:true});}
});
