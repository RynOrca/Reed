import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ProviderStore,normalizeDiscoveredModel} from "./providers.mjs";

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
