import test from 'node:test';
import assert from 'node:assert/strict';
import {AssessmentStore,validateQuestions} from './assessment-store.mjs';
test('学生试卷投影不含答案、解析及题型参考原文',()=>{
  const store=new AssessmentStore(null),row={id:'test-paper',title:'测试卷',body:JSON.stringify([{id:'q',type:'choice',prompt:'1+1=?',options:[{id:'A',text:'2'},{id:'B',text:'3'}],points:10,answer:'A',explanation:'隐藏解析'}])};
  const value=store.publicPaper(row);assert.equal(value.questions[0].answer,undefined);assert.equal(value.questions[0].explanation,undefined);assert.doesNotMatch(JSON.stringify(value),/隐藏解析/);
});
test('不保存缺答案、重复题或伪造引用的生成试卷',()=>{
  const q={type:'choice',prompt:'一加一',options:[{id:'A',text:'2'},{id:'B',text:'3'}],answer:'A',explanation:'两者相加'};
  assert.throws(()=>validateQuestions([{...q,answer:''}]),/参考答案/);assert.throws(()=>validateQuestions([q,q]),/重复/);
  assert.throws(()=>validateQuestions([q],{count:1,sources:[{documentId:'11111111-1111-1111-1111-111111111111',pageIndex:0}]}),/参考页/);
});
