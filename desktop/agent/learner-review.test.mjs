import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LearnerStore, learnerExtension, validateLearningEvent } from "./learner.mjs";

const offsetDays=(date,days)=>new Date(new Date(date).getTime()+days*86400000).toISOString();
const event=(result,subject="线性变换")=>({kind:"review",subject,detail:"复习线性变换",evidence:"我能解释线性变换",...(result===undefined?{}:{result})});

test("legacy persisted event ids still deduplicate after the result field is introduced",async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-review-legacy-"));
  try{
    const input=event(undefined),source="legacy-session";
    const id=createHash('sha256').update(JSON.stringify([source,input.kind,input.subject,input.evidence,input.detail,input.status,input.operation,input.targetSubject])).digest('hex');
    await writeFile(join(root,'learner.json'),JSON.stringify({events:[{...input,id,source,time:'2026-10-01T00:00:00.000Z',operation:'supplement'}]}));
    const store=new LearnerStore(root);await store.load();
    assert.equal(store.state.knowledge[0].nextReview,'2026-10-02T00:00:00.000Z');
    assert.equal(await store.record(input,source,[input.evidence]),false);assert.equal(store.state.events.length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("review receipts schedule explicit results conservatively and keep mastery unknown after reload",async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-review-"));
  try {
    const store=new LearnerStore(root);await store.load();
    for(const [result,days] of [["incorrect",1],["prompted",3],["independent",7]]){
      const current=event(result,`主题-${result}`),receipt=await store.recordWithReceipt(current,"test",[current.evidence]);
      const savedEvent=store.state.events.at(-1);
      assert.deepEqual(receipt,{saved:true,subject:current.subject,result,nextReview:offsetDays(savedEvent.time,days)});
      assert.equal(await store.record(current,"test",[current.evidence]),false,"duplicate keeps the legacy boolean API");
    }
    const explicitReload=new LearnerStore(root);await explicitReload.load();
    for(const [result,days] of [["incorrect",1],["prompted",3],["independent",7]]){
      const item=explicitReload.state.knowledge.find(value=>value.subject===`主题-${result}`);
      const savedEvent=explicitReload.state.events.find(value=>value.subject===item.subject);
      assert.equal(item.nextReview,offsetDays(savedEvent.time,days),`${result} interval survives reload`);
    }
    const unknown=event(undefined,"未知结果主题"),unknownReceipt=await store.recordWithReceipt(unknown,"test",[unknown.evidence]);
    assert.equal(unknownReceipt.result,"unknown");assert.equal(unknownReceipt.nextReview,offsetDays(store.state.events.at(-1).time,1));
    assert.equal(store.state.knowledge.find(item=>item.subject===unknown.subject).mastery,null);
    assert.equal(store.state.knowledge.find(item=>item.subject===unknown.subject).lastReviewResult,"unknown");
    const reload=new LearnerStore(root);await reload.load();
    const restored=reload.state.knowledge.find(item=>item.subject===unknown.subject);
    assert.equal(restored.nextReview,unknownReceipt.nextReview);assert.equal(restored.mastery,null);
    assert.equal(reload.state.events.at(-1).result,undefined,"unknown stays compatible with legacy event storage");
    assert.equal(await reload.record(unknown,"test",[unknown.evidence]),false,"duplicate survives reload");
  } finally {await rm(root,{recursive:true,force:true});}
});

test("review result validation accepts omitted results, rejects invalid results and non-review results",async()=>{
  assert.doesNotThrow(()=>validateLearningEvent(event(undefined)));
  assert.throws(()=>validateLearningEvent({...event("unsure"),result:"unsure"}),/复习结果/);
  assert.throws(()=>validateLearningEvent({kind:"concept",subject:"主题",detail:"细节",evidence:"用户原话",result:"independent"}),/复习结果/);
});

test("review tool reports the same persisted receipt and does not infer independent recall",async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-review-tool-"));
  try {
    const learner=new LearnerStore(root);await learner.load();const tools=new Map();
    const memory={state:{enabled:{l1:true}}};
    const session={sessionId:"test-session",state:{messages:[{role:"user",content:"我能解释线性变换"}]}};
    learnerExtension({learner,memory,currentSession:()=>session,send(){},judgeValue:async()=>[true]} )({registerTool:tool=>tools.set(tool.name,tool),on(){}});
    const tool=tools.get("record_learning_event"),input=event(undefined);
    const result=await tool.execute("call",input);
    const receipt=result.details.receipt;
    assert.equal(receipt.result,"unknown");assert.equal(receipt.subject,input.subject);
    assert.equal(result.content[0].text,`复习记录已保存：${receipt.subject}；下次复习：${receipt.nextReview}`);
    assert.equal(learner.state.knowledge[0].nextReview,receipt.nextReview);
    assert.equal(learner.state.knowledge[0].mastery,null);
  } finally {await rm(root,{recursive:true,force:true});}
});
