import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {providerHeaders} from './provider-headers.mjs';
import {ProviderStore} from './providers.mjs';
import {streamSimple} from '@earendil-works/pi-ai/compat';

test('OpenCode 请求标识跨轮稳定，不伪装其他客户端，不向其他域发送',()=>{
  for(const baseUrl of ['https://opencode.ai/inference/go/openai/v1','https://opencode.ai/zen/go/v1']){
    const headers=providerHeaders({baseUrl},'isolated-session',{custom:'preserved'});
    assert.equal(headers['x-opencode-session'],'isolated-session');assert.equal(headers['User-Agent'],'Reed/0.4.0');assert.equal(headers.custom,'preserved');
  }
  const original={custom:'test'};assert.equal(providerHeaders({baseUrl:'https://opencode.ai.example.com'},'test',original),original);
});

test('OpenCode Go 三类协议预设使用官方模型发现端点，保存 Responses 协议',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-go-')),seen=[];
  const runtime={getModels:()=>[],getModel:()=>null,refresh:async()=>{},setRuntimeApiKey:async()=>{}};
  try{
    const store=new ProviderStore(root,{request:async(url,options)=>{seen.push({url,headers:options.headers});return Response.json({data:[{id:'test-model',context_window:32768}]});}});
    const templates=store.templates(runtime).filter(t=>t.id.startsWith('opencode-go'));assert.equal(templates.length,3);
    for(const template of templates){
      const provider=await store.save({template:template.id,baseUrl:template.baseUrl,protocol:template.protocol});
      await store.discover(provider.id,runtime);assert.equal(provider.models[0].id,'test-model');
    }
    assert.ok(seen.every(r=>r.url==='https://opencode.ai/inference/go/v1/models'&&r.headers['x-opencode-session']&&r.headers['User-Agent']==='Reed/0.4.0'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('实际 SDK 流请求保留自有客户端标识和会话头',async()=>{
  const model={id:'test-model',provider:'test-open-code',api:'openai-completions',baseUrl:'https://opencode.ai/inference/go/openai/v1',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let seen;
  const stream=streamSimple(model,{messages:[{role:'user',content:'合成测试',timestamp:1}]},{apiKey:'test-only',headers:providerHeaders(model,'test-side-session'),fetch:async(url,init)=>{
    seen={url,headers:new Headers(init.headers)};
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'合成回复'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  assert.equal((await stream.result()).stopReason,'stop');assert.equal(seen.headers.get('x-opencode-session'),'test-side-session');assert.equal(seen.headers.get('user-agent'),'Reed/0.4.0');
});
