import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentStore} from './document-store.mjs';
test('教材只在当前科目可见，物理页限制在检索前生效',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-test-materials-')),store=new DocumentStore(root);
  try{
    const a=await store.createSubject(root,'数学'),b=await store.createSubject(root,'物理');await store.bind('session',root,a.id);
    const path=join(root,'test.pdf');await writeFile(path,'%PDF-1.7\n synthetic fixture');const doc=await store.importPdf('session',root,path,{name:'测试教材'});
    for(let i=0;i<2;i++)await store.cachePage('session',root,{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:2,text:'贝叶斯公式 第'+i+'页'});
    const hits=await store.search('session',root,'贝叶斯',{documentId:doc.id,maxPage:0});assert.equal(hits.length,1);assert.match(hits[0].url,/#page=1$/);
    await assert.rejects(store.snapshot('session',root,{sessionId:'another',readingVisible:true,documentId:doc.id,pageIndex:0,revision:doc.hash}),/其他会话/);
    await store.bind('session',root,b.id);await assert.rejects(store.document('session',root,doc.id),/当前科目/);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});


test('资料进入项目Materials/科目，迁移校验且保留原文件，项目相互隔离',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-test-project-materials-')),store=new DocumentStore(root),a=join(root,'project-a'),b=join(root,'project-b');
 try{await mkdir(a);await mkdir(b);const subject=await store.createSubject(a,'数学');await store.bind('a',a,subject.id);const file=join(root,'test.pdf');await writeFile(file,'%PDF-1.7 synthetic');const doc=await store.importPdf('a',a,file);
 assert.equal(doc.path,join(a,'Materials','数学',doc.id+'.pdf'));
 const old=join(root,'old.pdf');await writeFile(old,await readFile(doc.path));(await store.database()).prepare('UPDATE materials SET path=? WHERE id=?').run(old,doc.id);
 await store.list('a',a);assert.equal((await store.document('a',a,doc.id)).path,doc.path);assert.equal(await readFile(old,'utf8'),'%PDF-1.7 synthetic');assert.deepEqual(await store.subjects(b),[]);
 await writeFile(doc.path,'conflict');(await store.database()).prepare('UPDATE materials SET path=? WHERE id=?').run(old,doc.id);await assert.rejects(store.list('a',a),/冲突/);assert.equal((await store.document('a',a,doc.id)).path,old);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
