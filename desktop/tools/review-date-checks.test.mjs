import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDateChecks} from './review-date-checks.mjs';

function fixture(){
  const item={subject:'特征分解',nextReview:'2026-10-20T00:00:00.000Z'};
  return {profileSnapshots:{'after-review-answer':{learner:{knowledge:[item],events:[{kind:'review',subject:item.subject,result:'independent',time:'2026-10-13T00:00:00.000Z'}]}},'after-review-restart':{learner:{knowledge:[{...item}]}}},cases:[{name:'learning-review-answer',toolResults:[{type:'tool_end',isError:false,result:{details:{receipt:{saved:true,...item}}}}]},{name:'learning-review-restart',toolStarts:[{name:'recall_memory',args:{area:'review'}}],toolResults:[{type:'tool_end',isError:false,result:{content:[{type:'text',text:JSON.stringify([item])}]}}]}]};
}
test('tool_end without a name still verifies structured receipt and decoded recall',()=>{
  assert.deepEqual(Object.values(reviewDateChecks(fixture())),[true,true,true,true]);
});
test('wrong saved receipt and wrong recalled date fail independently',()=>{
  const report=fixture();report.cases[0].toolResults[0].result.details.receipt.nextReview='2026-10-14T00:00:00.000Z';
  report.cases[1].toolResults[0].result.content[0].text=JSON.stringify([{subject:'特征分解',nextReview:'2026-10-14T00:00:00.000Z'}]);
  assert.deepEqual(Object.values(reviewDateChecks(report)),[true,false,true,false]);
});
