import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DocumentStore} from './document-store.mjs';
import {generateMaterialOutline} from './material-outline.mjs';
import {materialsHarness,syntheticPptx} from '../tools/materials-test-harness.mjs';
test('大纲范围验证、缓存版本、无文字与失败不发布',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-test-outline-')),documents=new DocumentStore(root);try{const subject=await documents.createSubject(root,'test-数学');await documents.bind('s',root,subject.id);const path=join(root,'test.pdf');await writeFile(path,'%PDF-1.7 fixture');const doc=await documents.importPdf('s',root,path);
 for(let i=0;i<2;i++)await documents.cachePage('s',root,{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:2,text:'第'+i+'页 定义和示例'});
 const args={documents,sessionId:'s',workspace:root,documentId:doc.id,revision:doc.hash,model:{id:'mock',contextWindow:16000,maxTokens:4096},complete:async()=>({stopReason:'stop',content:[{type:'text',text:JSON.stringify({items:[{title:'定义',pageIndex:0,level:0},{title:'例子',pageIndex:1,level:1}]})}]})};
 const result=await generateMaterialOutline(args);assert.equal(result.items.length,2);assert.equal((await documents.outline('s',root,doc.id)).source,'model');
 await assert.rejects(generateMaterialOutline({...args,complete:async()=>({stopReason:'stop',content:[{type:'text',text:'{"items":[{"title":"越界","pageIndex":99,"level":0}]}'}]})}),/页码/);assert.equal((await documents.outline('s',root,doc.id)).items[0].title,'定义');
 await assert.rejects(documents.saveOutline('s',root,doc.id,'stale','native',result.items),/版本/);
 }finally{documents.close();await rm(root,{recursive:true,force:true});}
});
test('真实Bridge接通PPTX导入和模型大纲缓存，跨科目拒绝读取',{timeout:60000},async()=>{
 const h=await materialsHarness();try{await h.material('materials_create',{title:'test-PPTX'});const path=join(h.root,'test.pptx');await writeFile(path,syntheticPptx());const doc=await h.material('materials_import',{path,title:'test-PPTX',kind:'textbook'});assert.match(doc.path,/Materials/);assert.match(doc.path,/\.pptx$/);
 for(let i=0;i<3;i++)await h.material('materials_page',{page:{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:3,text:'SLIDE_'+i+'定义'}});
 const result=await h.material('materials_outline_generate',{documentId:doc.id,revision:doc.hash});assert.equal(result.items.length,3);assert.equal((await h.material('materials_outline_get',{documentId:doc.id})).source,'model');await h.material('materials_create',{title:'test-other'});await assert.rejects(h.material('materials_outline_get',{documentId:doc.id}),/当前科目/);
 }finally{await h.close();}
});

test('中文密集资料按token预算分批，批次覆盖全部页面',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-test-outline-budget-')),documents=new DocumentStore(root);try{const subject=await documents.createSubject(root,'test-中文');await documents.bind('s',root,subject.id);const path=join(root,'test.pdf');await writeFile(path,'%PDF-1.7 fixture');const doc=await documents.importPdf('s',root,path);for(let i=0;i<20;i++)await documents.cachePage('s',root,{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:20,text:'这是中文概念解释'.repeat(200)});const batches=[];
 await generateMaterialOutline({documents,sessionId:'s',workspace:root,documentId:doc.id,revision:doc.hash,model:{id:'mock',contextWindow:16000,maxTokens:4096},complete:async(_m,ctx)=>{const pages=JSON.parse(ctx.messages[0].content).pages;batches.push(pages);assert.ok(pages.reduce((sum,p)=>sum+p.text.length,0)<10000);return {stopReason:'stop',content:[{type:'text',text:JSON.stringify({items:[{title:'章节',pageIndex:pages[0].pageIndex,level:0}]})}]};}});assert.ok(batches.length>=3);assert.deepEqual(batches.flat().map(p=>p.pageIndex),Array.from({length:20},(_,i)=>i));
 }finally{documents.close();await rm(root,{recursive:true,force:true});}
});
