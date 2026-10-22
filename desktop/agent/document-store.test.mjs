import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentStore} from './document-store.mjs';
test('教材只在当前科目可见，物理页限制在检索前生效',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-test-materials-')),store=new DocumentStore(root);
  try{
    const a=await store.createSubject('/test','数学'),b=await store.createSubject('/test','物理');await store.bind('session','/test',a.id);
    const path=join(root,'test.pdf');await writeFile(path,'%PDF-1.7\n synthetic fixture');const doc=await store.importPdf('session','/test',path,{name:'测试教材'});
    for(let i=0;i<2;i++)await store.cachePage('session','/test',{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:2,text:'贝叶斯公式 第'+i+'页'});
    const hits=await store.search('session','/test','贝叶斯',{documentId:doc.id,maxPage:0});assert.equal(hits.length,1);assert.match(hits[0].url,/#page=1$/);
    await assert.rejects(store.snapshot('session','/test',{sessionId:'another',readingVisible:true,documentId:doc.id,pageIndex:0,revision:doc.hash}),/其他会话/);
    await store.bind('session','/test',b.id);await assert.rejects(store.document('session','/test',doc.id),/当前科目/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
