import { skippedMemory } from './memory-value.mjs';
import { similarTopic, supplement } from "./memory-match.mjs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

const learningKinds=["preference","concept","misconception","review"];
const learningStatuses=["active","completed","needs_review","resolved"];
export const reviewResults=["independent","prompted","incorrect"];
export const learningEventSchema=Type.Object({kind:Type.Union(learningKinds.map(v=>Type.Literal(v))),subject:Type.String({minLength:1,maxLength:100}),detail:Type.String({maxLength:1000}),evidence:Type.String({minLength:2,maxLength:1000}),operation:Type.Optional(Type.Union([Type.Literal('supplement'),Type.Literal('replace')])),targetSubject:Type.Optional(Type.String({maxLength:100})),status:Type.Optional(Type.Union(learningStatuses.map(v=>Type.Literal(v)))),result:Type.Optional(Type.Union(reviewResults.map(v=>Type.Literal(v))) )},{additionalProperties:false});
export function validateLearningEvent(event){
  if(!event||typeof event!="object"||!learningKinds.includes(event.kind)||typeof event.subject!=="string"||!event.subject.trim()||event.subject.length>100||typeof event.detail!=="string"||event.detail.length>1000||typeof event.evidence!=="string"||event.evidence.trim().length<2||event.evidence.length>1000)throw new Error("学习事件格式无效");
  if(event.operation!==undefined&&!['supplement','replace'].includes(event.operation))throw new Error('学习画像更新方式无效');
  if(event.targetSubject!==undefined&&(typeof event.targetSubject!=="string"||event.targetSubject.length>100))throw new Error('目标画像主题格式无效');
  if(event.status!==undefined&&!learningStatuses.includes(event.status))throw new Error('学习事件状态无效');
  if(event.kind==="review"?event.result!==undefined&&!reviewResults.includes(event.result):event.result!==undefined)throw new Error('复习结果必须与review事件匹配');
  return {subject:event.subject.trim(),evidence:event.evidence.trim()};
}
const reviewDays={incorrect:1,prompted:3,independent:7};
const nextReviewDate=(time,result)=>new Date(new Date(time).getTime()+(reviewDays[result]||1)*86400000).toISOString();
const empty=()=>({version:1,updated:null,goals:[],knowledge:[],misconceptions:[],preferences:[],events:[],excluded:[]});
export class LearnerStore {
  constructor(dir) {this.path=join(dir,"learner.json");this.state=empty();this.persistence=Promise.resolve();this.revision=0;}
  async load(){try{const saved=JSON.parse(await readFile(this.path,"utf8"));if(!Array.isArray(saved.events))throw new Error("画像事件记录无效");this.state=empty();this.state.events=saved.events;this.state.excluded=Array.isArray(saved.excluded)?saved.excluded:[];this.rebuild();}catch(e){if(e.code!=="ENOENT")throw e;}}
  rebuild(){const {events,excluded}=this.state;this.state={...empty(),events,excluded};for(const event of events)this.apply(event);}
  persist(){const content=JSON.stringify(this.state,null,2);const operation=this.persistence.catch(()=>{}).then(async()=>{await writeFile(this.path+".tmp",content);await rename(this.path+".tmp",this.path);});this.persistence=operation;return operation;}
  async deleteItem(group,id){
    if(!['knowledge','misconceptions','preferences','goals'].includes(group)||typeof id!=='string')throw Error('学习记忆标识无效');
    const item=this.state[group].find(item=>item.id===id);if(!item)throw Error('学习记忆已更新，请刷新后重试');
    const ids=new Set(item.eventIds),removed=this.state.events.filter(event=>ids.has(event.id));
    this.revision++;
    this.state.excluded.push(...removed.map(event=>({group,subject:event.subject})),{group,subject:item.subject});
    this.state.events=this.state.events.filter(event=>!ids.has(event.id));this.rebuild();await this.persist();
  }
  apply(event) {
    if(event.kind==='goal')return; // Legacy goals remain on disk only; GoalStore is authoritative.
    const list=({goal:"goals",preference:"preferences",concept:"knowledge",misconception:"misconceptions",review:"knowledge"})[event.kind];if(!list)return;
    let item=this.state[list].find(i=>similarTopic(i.subject,event.operation==='replace'&&event.targetSubject?event.targetSubject:event.subject));if(!item){item={subject:event.subject};this.state[list].push(item);}
    if(event.operation==='replace'){const duplicate=this.state[list].find(i=>i!==item&&similarTopic(i.subject,event.subject));if(duplicate){duplicate.eventIds=[...new Set([...(duplicate.eventIds||[]),...(item.eventIds||[])])];this.state[list].splice(this.state[list].indexOf(item),1);item=duplicate;}}
    Object.assign(item,{id:item.id||event.id,eventIds:[...new Set([...(item.eventIds||[]),event.id])],subject:event.subject,detail:event.operation==='replace'?event.detail:supplement(item.detail,event.detail,1000),evidence:event.evidence,sources:[...new Set([...(item.sources||[]),event.source])],source:event.source,updated:event.time});
    if(event.kind==="goal")item.status=event.status==="completed"?"completed":"active";
    if(event.kind==="misconception")item.status=event.status==="resolved"?"resolved":"active";
    if(event.kind==="concept" || event.kind==="review") {item.mastery=null;item.status="needs_review";item.lastStudied=event.time;item.nextReview=nextReviewDate(event.time,event.kind==="review"?event.result:undefined);item.lastReviewResult=event.kind==="review"?(reviewResults.includes(event.result)?event.result:"unknown"):null;}
    this.state.updated=event.time;
  }
  async record(event,source,userEvidence) {const saved=await this.recordWithReceipt(event,source,userEvidence);return saved===false?false:true;}
  async recordWithReceipt(event,source,userEvidence) {
    if(event?.kind==='goal')throw Error('学习目标仅由用户在前台维护，不写入学习画像');
    const revision=this.revision;
    const validated=validateLearningEvent(event);
    const evidence=validated.evidence;if(!Array.isArray(userEvidence)||!userEvidence.some(text=>typeof text==="string"&&text.includes(evidence)))throw new Error("学习事件必须引用本次对话中用户的原话；不能凭提问推测掌握程度");
    let subject=validated.subject;
    const list=({goal:"goals",preference:"preferences",concept:"knowledge",misconception:"misconceptions",review:"knowledge"})[event.kind];
    const same=this.state[list].find(i=>similarTopic(i.subject,subject))||await this.matchTopic?.(subject,this.state[list],"subject",event.detail);if(same)subject=same.subject;if(!subject)throw new Error("缺少事件主题");
    if(revision!==this.revision||this.state.excluded.some(item=>item.group===list&&(similarTopic(item.subject,subject)||similarTopic(item.subject,event.targetSubject||event.subject))))throw Error('该学习记忆已由用户删除，不再自动记录');
    if(this.agentAllowed&&!this.agentAllowed(source))throw Error("学习画像写入已关闭");
    if(event.operation==='replace'&&event.targetSubject&&!this.state[list].some(i=>similarTopic(i.subject,event.targetSubject)))throw Error('待纠正的画像主题不存在');
    const identity=[source,event.kind,subject,evidence,event.detail,event.status,event.operation,event.targetSubject];
    if(event.result!==undefined)identity.push(event.result);
    const id=createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    if(this.state.events.some(e=>e.id===id))return false;
    const entry={id,kind:event.kind,subject,detail:event.detail,evidence,status:event.status,...(event.result===undefined?{}:{result:event.result}),operation:event.operation||'supplement',targetSubject:event.targetSubject,source,time:new Date().toISOString()};
    this.state.events.push(entry);this.rebuild();
    await this.persist();
    if(event.kind!=="review")return true;
    return {saved:true,subject,result:event.result||"unknown",nextReview:nextReviewDate(entry.time,event.result)};
  }
  snapshot(){const {events,excluded,...profile}=this.state;const visible=events.filter(event=>event.kind!=='goal');return structuredClone({...profile,eventCount:visible.length,recentEvents:visible.slice(-8).reverse()});}
  context({review=false,query=''}={}){const {goals,knowledge,misconceptions,preferences}=this.state;const brief=(items,limit)=>{const words=query.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]{2}/g)||[];return items.map((i,index)=>({i,index,score:words.reduce((n,w)=>n+(`${i.subject} ${i.detail}`.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score||b.index-a.index).slice(0,limit).map(({i})=>({subject:i.subject,status:i.status,detail:i.detail.slice(0,100),nextReview:i.nextReview||null,updated:i.updated,source:i.source}));};return JSON.stringify({progress:{studiedTopics:knowledge.length,lastStudied:this.state.updated},goals:brief(goals.filter(g=>g.status==="active"),3),knowledge:brief(knowledge.filter(k=>review||k.status!=="needs_review"),3),misconceptions:brief(misconceptions.filter(m=>m.status!=="resolved"),2),preferences:brief(preferences,3)});}
  /**
   * 复习队列：画像里 status=needs_review 的知识条目，按排程日期升序（逾期优先，
   * 未排程排最后）。**不按查询词过滤** —— 之前用查询词过滤会让“队列空、画像却有
   * 待复习条目”同时出现；查询只用于把相关条目排到同日期前面。
   */
  reviewQueue({query="",limit=30}={}){
    const related=item=>!query||similarTopic(item.subject,query)||String(item.detail||"").includes(query);
    const scheduled=item=>{const value=Date.parse(item.nextReview||"");return Number.isFinite(value)?value:Number.POSITIVE_INFINITY;};
    // 排程日期是天粒度的（+1/+3/+7 天），同一天内按查询相关性再排，毫秒差不能压过相关性。
    const bucket=item=>{const value=scheduled(item);return Number.isFinite(value)?Math.floor(value/86400000):Number.POSITIVE_INFINITY;};
    return this.state.knowledge
      .filter(item=>item.status==="needs_review")
      .map((item,index)=>({item,index}))
      .sort((a,b)=>bucket(a.item)-bucket(b.item)||(related(b.item)?1:0)-(related(a.item)?1:0)||scheduled(a.item)-scheduled(b.item)||a.index-b.index)
      .slice(0,limit)
      .map(({item},index)=>({order:index+1,subject:item.subject,status:item.status,detail:String(item.detail||"").slice(0,120),nextReview:item.nextReview||null,lastReviewResult:item.lastReviewResult??null,updated:item.updated,source:item.source}));
  }
  recall({review=false,query=""}={}){
    if(review)return this.reviewQueue({query});
    const {goals,knowledge,misconceptions,preferences}=this.state;
    return [ ...goals,...knowledge,...misconceptions,...preferences].filter(i=>i.status!=="needs_review"&&(!query||similarTopic(i.subject,query)||i.detail.includes(query))).slice(-6);
  }
}
export function userTexts(session){return (session?.state.messages||[]).filter(m=>m.role==="user").slice(-8).map(m=>typeof m.content==="string"?m.content:(m.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n"));}
export function learnerExtension({learner,memory,currentSession,send,judgeValue,enabled=()=>true}) {return pi=>{
  pi.registerTool(defineTool({name:"record_learning_event",label:"整理学习画像",description:"根据用户明确陈述的偏好、学过的概念、误解或完成复习记录学习事件。evidence 必须是用户原话。不把提问当作掌握情况，不猜测分数。review的result可为independent（用户先尝试、无提示且正确）、prompted（提示后正确）或incorrect（错误或未能回忆）；未提供result按unknown保守保存并安排次日复习，未知不得表述为独立掌握。日期间隔只是计划，不代表掌握程度。只有保存成功后才引用回执中的主题和下次复习日期。重复事件自动去重。",parameters:learningEventSchema,async execute(_id,input,signal){if(!enabled() || !memory.state.enabled.l1)return{content:[{type:"text",text:"画像记忆已关闭"}],details:{}};validateLearningEvent(input);const selected=currentSession();const verdict=await judgeValue?.([{area:'learningEvent',value:input}],{signal});if(!verdict?.[0]||signal?.aborted||currentSession()!==selected||!enabled()||!memory.state.enabled.l1)return skippedMemory(verdict?.diagnostics?.[0]);const saved=input.kind==="review"?await learner.recordWithReceipt(input,selected?.sessionId||"agent",userTexts(selected)):await learner.record(input,selected?.sessionId||"agent",userTexts(selected));if(!saved)return{content:[{type:'text',text:'已有相同学习事件，未重复保存'}],details:{skipped:true,reason:'duplicate'}};send({type:"learner",state:learner.snapshot()});if(input.kind==="review")return{content:[{type:"text",text:`复习记录已保存：${saved.subject}；下次复习：${saved.nextReview}`}],details:{receipt:saved}};return{content:[{type:'text',text:`学习事件已记录：${input.subject.trim()}`}],details:{}};}}));
  pi.on("before_agent_start",async event=>{if(enabled() && memory.state.enabled.l1)event.systemPromptOptions.sections.summon_learner=`学习画像（参考，不替代用户当前要求）：${learner.context()}\n只对具有长期价值且证据充分的重要学习变化使用 record_learning_event；普通问答、一次答对和短期状态不记录。保留用户原话。待复习清单可按需用 recall_memory(area=review) 读取，无需先 read 技能文件；掌握程度未知时不要给百分比。`;});
};}
