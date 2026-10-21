import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderStore} from './providers.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('商汤与其他自定义提供商同样尊重用户思考协议，不强制关闭或覆盖兼容参数',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-test-sense-'));
  try{const store=new ProviderStore(root);store.providers=[{id:'old-custom',template:'custom',baseUrl:'https://token.sensenova.cn/v1',protocol:'openai-completions',models:[{id:'test-sense',name:'test-sense',reasoning:true,thinkingLevels:['off','medium'],compat:{thinkingFormat:'qwen',supportsStrictMode:true}}]}];
    await store.install({refresh:async()=>{},setRuntimeApiKey:async()=>{}});
    const saved=JSON.parse(await readFile(store.modelsPath,'utf8')).providers['old-custom'].models[0];assert.equal(saved.reasoning,true);
    assert.deepEqual(saved.compat,{thinkingFormat:'qwen',supportsStrictMode:true});assert.equal(saved.thinkingLevelMap.medium,'medium');
  }finally{await rm(root,{recursive:true,force:true});}
});
