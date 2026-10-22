import test from 'node:test';
import assert from 'node:assert/strict';
import {materialsHarness} from '../tools/materials-test-harness.mjs';
test('真实 bridge：按页问答、侧边上下文、科目隔离及独立试卷答案投影',{timeout:60000},async()=>{
  const h=await materialsHarness();try{
    const a=await h.material('materials_create',{title:'test-数学'}),subjectA=a.subject.id;
    const doc=await h.material('materials_import',{path:h.pdf,title:'test-教材',kind:'textbook'});
    for(let i=0;i<2;i++)await h.material('materials_page',{page:{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:2,text:i===0?'PAGE_ONE_MARKER Alpha formula':'PAGE_TWO_FUTURE Hidden later page'}});
    const readingContext={sessionId:h.sessionId,documentId:doc.id,revision:doc.hash,pageIndex:0,selectionText:'PAGE_ONE_MARKER',readingVisible:true,capturedAt:Date.now()};
    let from=h.requests.length;await h.call('prompt',{sessionId:h.sessionId,text:'这一步为什么？',readingContext});
    const main=JSON.stringify(h.requests.slice(from));assert.match(main,/PAGE_ONE_MARKER/);assert.doesNotMatch(main,/PAGE_TWO_FUTURE/);assert.equal(h.requests.length-from,1,'自动检索不产生额外模型调用');
    from=h.requests.length;await h.side('再解释一下这一步',readingContext);const side=JSON.stringify(h.requests.slice(from));assert.match(side,/PAGE_ONE_MARKER/);assert.match(side,/SYNTHETIC_REPLY/);assert.doesNotMatch(side,/PAGE_TWO_FUTURE/);
    const b=await h.material('materials_create',{title:'test-物理'});await assert.rejects(h.material('materials_bytes',{documentId:doc.id,offset:0}),/当前科目/);
    await h.material('materials_select',{subjectId:subjectA});
    from=h.requests.length;const paper=await h.material('materials_paper_generate',{options:{count:1,topic:'',type:'choice',documentId:doc.id,maxPage:0}});
    assert.equal(paper.questions.length,1);assert.doesNotMatch(JSON.stringify(paper),/PRIVATE_TEACHER_EXPLANATION|"answer"|"explanation"/);assert.doesNotMatch(JSON.stringify(h.requests.slice(from)),/PAGE_TWO_FUTURE/);
    const before=h.requests.length,submitted=await h.material('materials_paper_submit',{paperId:paper.id,answers:{[paper.questions[0].id]:'A'}});assert.equal(h.requests.length,before,'选择题无需模型评分');assert.equal(submitted.grading[0].score,10);assert.match(JSON.stringify(submitted),/PRIVATE_TEACHER_EXPLANATION/);
    const gate=h.holdGeneration(),pending=h.material('materials_paper_generate',{options:{count:1,topic:'',type:'choice',documentId:doc.id,maxPage:0}});await gate.started;await h.material('materials_select',{subjectId:b.subject.id});gate.release();await assert.rejects(pending,/科目已切换/);
    assert.equal((await h.material('materials_paper_list')).papers.length,0,'旧科目结果不得写入新科目');
  }finally{await h.close();}
});
