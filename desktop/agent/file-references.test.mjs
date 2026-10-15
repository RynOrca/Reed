import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CapabilityStore} from './capabilities.mjs';
test('引用使用真实URL；相对笔记名可唯一回查，歧义和越界不猜测',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-citations-'));try{
    const work=join(root,'project'),vault=join(root,'vault'),notes=join(vault,'章节');await mkdir(work);await mkdir(notes,{recursive:true});
    const file=join(notes,'用户记忆与知识库.md');await writeFile(file,'synthetic');const store=new CapabilityStore(root);store.state.vaultPath=vault;
    assert.equal(await store.resolveFile('summon-file:'+encodeURIComponent(file)+'#L176',work),file);
    assert.equal(await store.resolveFile('用户记忆与知识库.md',work),file);
    assert.equal(await store.resolveFile('[[章节/用户记忆与知识库.md]]',work),file);
    await writeFile(join(vault,'用户记忆与知识库.md'),'other');await assert.rejects(store.resolveFile('其他目录/用户记忆与知识库.md',work),/同名/);
    await assert.rejects(store.resolveFile('../../missing.md',work),/范围/);
    await assert.rejects(store.resolveFile('不存在.md',work),/不存在/);
    const outside=join(root,'secret.md');await writeFile(outside,'synthetic');await assert.rejects(store.resolveFile(outside,work),/范围|目录内/);
  }finally{await rm(root,{recursive:true,force:true});}
});
