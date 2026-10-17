import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ProviderStore,normalizeDiscoveredModel} from "./providers.mjs";

test("provider save keeps name and concurrency while ignoring retired wait fields",async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-provider-save-'));
 try{
  const crypto={protect:async x=>x,unprotect:async x=>x};
  const store=new ProviderStore(root,crypto);
  const input={template:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:12345/v1'};
  const provider=await store.save({...input,name:'one',parallelRequests:true,maxConcurrentRequests:3});
  await store.save({...input,providerId:provider.id,name:'renamed'});
  const reload=new ProviderStore(root,crypto);await reload.load();
  assert.equal(reload.snapshot()[0].name,'renamed');
  assert.equal(reload.snapshot()[0].parallelRequests,true);
  assert.equal(reload.snapshot()[0].maxConcurrentRequests,3);
  assert.equal(reload.snapshot()[0].deployment,undefined,'部署类型不再是可配置项');
  assert.equal(reload.snapshot()[0].foregroundTotalMs,undefined,'不再保存单次生成时限');
 }finally{await rm(root,{recursive:true,force:true});}
});

test("model discovery reads advertised output limits without guessing missing limits",()=>{
 for(const metadata of [{max_output_tokens:32768},{max_completion_tokens:32768},{max_tokens:32768},{limit:{output:32768}},{metadata:{max_output_tokens:32768}},{metadata:{max_completion_tokens:32768}},{metadata:{max_tokens:32768}},{metadata:{limit:{output:32768}}}]) {
  const model=normalizeDiscoveredModel({id:"custom",...metadata});assert.equal(model.maxTokens,32768);assert.equal(model.infoSource,"service");
 }
 assert.equal(normalizeDiscoveredModel({id:"custom"}).maxTokens,null);
 assert.equal(normalizeDiscoveredModel({id:"custom",max_tokens:0},{maxTokens:8192}).maxTokens,8192);
});

test("explicit output limit reaches SDK configuration and survives discovery, refresh and reload",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-output-limit-"));
 try {
  let sdkModels={};const crypto={protect:async k=>k,unprotect:async k=>k};
  const store=new ProviderStore(root,{...crypto,request:async()=>({ok:true,json:async()=>({data:[{id:"custom",max_tokens:4096}]})})});
  const runtime={getModels:()=>[],getModel:(p,id)=>sdkModels[p]?.models.find(m=>m.id===id),refresh:async()=>{sdkModels=JSON.parse(await readFile(store.modelsPath,"utf8")).providers;for(const provider of Object.values(sdkModels))for(const model of provider.models)model.maxTokens??=16384;},setRuntimeApiKey:async()=>{}};
  const provider=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions"});
  await store.updateModel(provider.id,{id:"custom",contextWindow:262144},runtime);
  assert.equal(store.modelInfo(provider.id,"custom",runtime).maxTokens,16384);
  for(const invalid of [0,-1,1.5,NaN,Infinity,"32768",Number.MAX_SAFE_INTEGER+1]) await assert.rejects(store.updateModel(provider.id,{id:"custom",maxTokens:invalid},runtime),/正整数/);
  assert.equal(provider.models[0].maxTokens,null);
  await store.updateModel(provider.id,{id:"custom",maxTokens:32768},runtime);
  assert.equal(store.modelInfo(provider.id,"custom",runtime).maxTokens,32768);
  assert.equal(JSON.parse(await readFile(store.modelsPath,"utf8")).providers[provider.id].models[0].maxTokens,32768);
  await store.discover(provider.id,runtime);assert.equal(provider.models[0].maxTokens,32768);
  await store.refreshModel(provider.id,"custom",runtime);assert.equal(provider.models[0].maxTokens,32768);
  const reload=new ProviderStore(root,crypto);await reload.load();assert.equal(reload.providers[0].models[0].overrides.maxTokens,32768);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("refresh one model preserves siblings; provider deletion removes credential and SDK config",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-management-"));
 try {
  let store;let response=[{id:"one",context_length:32768,reasoning_efforts:["low","high"]},{id:"two",context_length:8192}];
  const keys=new Map(),runtime={getModels:()=>[],getModel:(p,id)=>store.providers.find(m=>m.id===p)?.models.find(m=>m.id===id),refresh:async()=>{},setRuntimeApiKey:async(p,k)=>keys.set(p,k)};
  const crypto={protect:async k=>"encrypted:"+k,unprotect:async k=>k.slice(10)};
  store=new ProviderStore(root,{...crypto,request:async()=>({ok:true,json:async()=>({data:response})})});await store.load();
  const first=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions",key:"test-secret"});await store.discover(first.id,runtime);
  const other=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12346/v1",protocol:"openai-completions"});await store.updateModel(other.id,{id:"other",contextWindow:65536},runtime);
  response=[{id:"one",context_length:262144,reasoning_efforts:["low","high"]}];
  const config=await store.refreshModel(first.id,"one",runtime);assert.equal(config.contextWindow,262144);assert.deepEqual(config.thinkingLevels,["off","low","high"]);assert.equal(first.models.find(m=>m.id==="two").contextWindow,8192);
  await assert.rejects(store.refreshModel(first.id,"missing",runtime),/未返回/);
  await store.remove(first.id,runtime);assert.equal(keys.get(first.id),"");await assert.rejects(stat(join(root,first.id+".dpapi")),{code:"ENOENT"});
  const saved=JSON.parse(await readFile(store.modelsPath,"utf8"));assert.equal(saved.providers[first.id],undefined);assert.ok(saved.providers[other.id]);
  const reload=new ProviderStore(root,crypto);await reload.load();assert.deepEqual(reload.providers.map(p=>p.id),[other.id]);assert.ok(!(await readFile(store.path,"utf8")).includes("test-secret"));
 } finally {await rm(root,{recursive:true,force:true});}
});


test("parallel requests are opt-in, validated, persisted and preserved by older save callers",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-parallel-config-"));
 try{
  const crypto={protect:async key=>key,unprotect:async key=>key};const store=new ProviderStore(root,crypto);
  const input={template:"custom",baseUrl:"http://127.0.0.1:1234/v1",protocol:"openai-completions"};
  const provider=await store.save(input);assert.equal(provider.parallelRequests,false);assert.equal(provider.maxConcurrentRequests,2);
  for(const value of [0,1,9,2.5,"2",null])await assert.rejects(store.save({...input,providerId:provider.id,parallelRequests:true,maxConcurrentRequests:value}),/最大并发数/);
  await assert.rejects(store.save({...input,providerId:provider.id,parallelRequests:"yes"}),/并行请求设置/);
  await store.save({...input,providerId:provider.id,parallelRequests:true,maxConcurrentRequests:3});
  await store.save({...input,providerId:provider.id,name:"legacy caller"});
  const reload=new ProviderStore(root,crypto);await reload.load();assert.equal(reload.providers[0].parallelRequests,true);assert.equal(reload.providers[0].maxConcurrentRequests,3);
  await store.save({...input,providerId:provider.id,parallelRequests:false,maxConcurrentRequests:3});assert.equal(store.providers[0].parallelRequests,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Qwen switch to effort restores depth levels and persists through rediscovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-thinking-protocol-'));
 try{
  const store=new ProviderStore(root,{protect:async x=>x,unprotect:async x=>x,request:async()=>({ok:true,json:async()=>({data:[{id:'test',thinking_format:'qwen'}]})})});
  const runtime={refresh:async()=>{},setRuntimeApiKey:async()=>{},getModels:()=>[],getModel:()=>null};
  const provider=await store.save({template:'custom',baseUrl:'http://127.0.0.1:1234/v1',protocol:'openai-completions'});
  await store.updateModel(provider.id,{id:'test',thinkingFormat:'qwen'},runtime);assert.deepEqual(provider.models[0].thinkingLevels,['off','medium']);
  await store.updateModel(provider.id,{id:'test',thinkingFormat:'openai'},runtime);assert.deepEqual(provider.models[0].thinkingLevels,['off','low','medium','high','xhigh']);
  await store.discover(provider.id,runtime);assert.equal(provider.models[0].compat.thinkingFormat,'openai');assert.deepEqual(provider.models[0].thinkingLevels,['off','low','medium','high','xhigh']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("provider saves are idempotent after discovery failure; model availability persists and defaults on",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-model-toggle-"));
 try{
  const crypto={protect:async key=>key,unprotect:async key=>key};
  const store=new ProviderStore(root,{...crypto,request:async()=>{throw new Error("offline")}});
  const runtime={getModels:()=>[],getModel:()=>null,refresh:async()=>{},setRuntimeApiKey:async()=>{}};
  const input={template:"custom",clientRequestId:"e26b74ac-8fa9-4e8a-94a7-b8e7a2bb24d1",name:"temporary provider",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions"};
  const first=await store.save(input);
  await assert.rejects(store.discover(first.id,runtime),/连接模型服务失败/);
  const retry=await store.save(input);
  assert.equal(retry.id,first.id);
  assert.equal(store.providers.length,1);
  await store.updateModel(first.id,{id:"enabled-by-default"},runtime);
  await store.updateModel(first.id,{id:"disabled-model",enabled:false},runtime);
  const repeated=await store.save(input);
  assert.equal(repeated.id,first.id);
  assert.equal(store.providers.length,1);
  assert.equal(first.models[0].enabled,undefined);
  assert.equal(first.models[1].enabled,false);
  await store.install(runtime);
  let sdk=JSON.parse(await readFile(store.modelsPath,"utf8"));
  assert.deepEqual(sdk.providers[first.id].models.map(model=>model.id),["enabled-by-default"]);
  const reload=new ProviderStore(root,crypto);await reload.load();
  assert.equal(reload.providers[0].models[0].enabled,undefined);
  assert.equal(reload.providers[0].models[1].enabled,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("provider draft IDs are UUID-validated and survive lost acknowledgements",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-draft-id-"));
 try{
  const store=new ProviderStore(root,{protect:async value=>value,unprotect:async value=>value});
  const input={template:"custom",clientRequestId:"e26b74ac-8fa9-4e8a-94a7-b8e7a2bb24d1",name:"draft",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions"};
  await assert.rejects(store.save({...input,clientRequestId:"retry"}),/草稿标识无效/);
  const [created,concurrent]=await Promise.all([store.save({...input,key:"draft-secret"}),store.save({...input,key:"draft-secret"})]);
  assert.equal(concurrent.id,created.id);
  assert.equal(store.providers.length,1);
  const loaded=new ProviderStore(root,{protect:async value=>value,unprotect:async value=>value});await loaded.load();
  const retry=await loaded.save(input);
  assert.equal(retry.id,created.id);
  assert.equal(loaded.providers.length,1);
  const editedLegacy=await loaded.save({template:"custom",providerId:created.id,clientRequestId:null,name:"legacy edited",baseUrl:"http://127.0.0.1:12346/v1",protocol:"openai-completions"});
  assert.equal(editedLegacy.id,created.id);
  assert.equal(loaded.providers.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("provider model fetch translates timeout and invalid response bodies",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-fetch-errors-"));
 try{
  const store=new ProviderStore(root,{protect:async value=>value,unprotect:async value=>value,request:async(_url,{signal})=>({ok:true,json:async()=>{assert.ok(signal instanceof AbortSignal);const error=new SyntaxError("bad json");throw error;}})});
  const provider=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions"});
  const runtime={getModels:()=>[],getModel:()=>null,refresh:async()=>{},setRuntimeApiKey:async()=>{}};
  await assert.rejects(store.discover(provider.id,runtime),/模型服务返回内容无法解析/);
  store.request=async()=>{const error=new Error("aborted");error.name="AbortError";throw error;};
  await assert.rejects(store.refreshModel(provider.id,"missing",runtime),/连接模型服务超时/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("provider installs are serialized per store",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-install-queue-"));
 try{
  const store=new ProviderStore(root,{protect:async value=>value,unprotect:async value=>value});
  const provider=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions"});
  provider.models.push(normalizeDiscoveredModel({id:"queued-install"}));
  let active=0,maxActive=0,refreshes=0;
  const runtime={refresh:async()=>{refreshes++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,10));active--;},setRuntimeApiKey:async()=>{}};
  await Promise.all([store.install(runtime),store.install(runtime)]);
  assert.equal(maxActive,1);
  assert.equal(refreshes,2);
  const saved=JSON.parse(await readFile(store.modelsPath,"utf8"));
  assert.equal(saved.providers[provider.id].models[0].id,"queued-install");
 }finally{await rm(root,{recursive:true,force:true});}
});

test("newly discovered models stay out of the picker until enabled; legacy models remain enabled",async()=>{
 const root=await mkdtemp(join(tmpdir(),"summon-provider-discovery-toggle-"));
 try{
  const store=new ProviderStore(root,{protect:async value=>value,unprotect:async value=>value,request:async()=>({ok:true,json:async()=>({data:[{id:"legacy-model"},{id:"new-model"}]})})});
  const provider=await store.save({template:"custom",baseUrl:"http://127.0.0.1:12345/v1",protocol:"openai-completions"});
  provider.models.push(normalizeDiscoveredModel({id:"legacy-model"}));await store.persist();
  const runtime={getModels:()=>[],getModel:()=>null,refresh:async()=>{},setRuntimeApiKey:async()=>{}};
  await store.discover(provider.id,runtime);
  assert.equal(provider.models.find(model=>model.id==="legacy-model").enabled,undefined);
  assert.equal(provider.models.find(model=>model.id==="new-model").enabled,false);
  let saved=JSON.parse(await readFile(store.modelsPath,"utf8"));
  assert.deepEqual(saved.providers[provider.id].models.map(model=>model.id),["legacy-model"]);
  await store.updateModel(provider.id,{id:"new-model",enabled:true},runtime);
  await store.refreshModel(provider.id,"new-model",runtime);
  await store.refreshModel(provider.id,"legacy-model",runtime);
  assert.equal(provider.models.find(model=>model.id==="new-model").enabled,true);
  assert.equal(provider.models.find(model=>model.id==="legacy-model").enabled,undefined);
  saved=JSON.parse(await readFile(store.modelsPath,"utf8"));
  assert.deepEqual(saved.providers[provider.id].models.map(model=>model.id),["legacy-model","new-model"]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("DeepSeek uses the OpenAI-compatible base URL without a version suffix",()=>{
 const store=new ProviderStore(".");
 assert.equal(store.templates({getModels:()=>[]}).find(template=>template.id==="deepseek").baseUrl,"https://api.deepseek.com");
});
