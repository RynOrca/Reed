import { similarTopic, supplement, reviewOnly } from "./memory-match.mjs";
import { LocalSearchIndex } from './local-search.mjs';
import { applicableWork, shellEnvironment } from './work-applicability.mjs';
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_PROFILE = 6000;
const MAX_NOTES = 100;
const MAX_NOTE_BODY = 20000;
export const isLearningGoal = key => /学习目标|长期目标|learning[_ -]?goals?/i.test(String(key||''));
const defaultState = () => ({ enabled: { l1: true, l2: true, l3: true, work:true }, profile: "", facts: [], notes: [], working: [] });
const historyCache = new Map();
function workEnvironment(item){
  const text=`${item.title} ${item.body}`.toLowerCase();
  const observed=(item.evidenceRefs||[]).map(r=>shellEnvironment(r.shell)).filter(Boolean);
  const family=shellEnvironment(item.environment)||shellEnvironment(text);
  const shells=[...new Set(observed.length?observed:family?[family]:[])].sort();
  const paths=item.kind==='path'?[...new Set(text.match(/[a-z]:[\\/][^\s，。；;"']+|\/(?:home|users|opt|usr)\/[^\s，。；;"']+/g)||[])].sort():[];
  return JSON.stringify({shells,paths,scope:item.scope||''});
}
function sameEnvironment(a,b){
  if(!a||!b||a===b)return true;
  const left=shellEnvironment(a),right=shellEnvironment(b);
  return !!left&&left===right;
}

function terms(text) {
  const normalized = String(text).toLowerCase();
  const words = normalized.match(/[a-z0-9_]{2,}/g) || [];
  const han = (normalized.match(/[\p{Script=Han}]+/gu) || []).flatMap((part) =>
    part.length < 2 ? [part] : Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)));
  return [...new Set([...words, ...han])].slice(0, 80);
}

function score(query, text) {
  const haystack = String(text).toLowerCase();
  return terms(query).reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
}

function extractText(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return "";
  const content = message.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content
    .filter((block) => block?.type === "text").map((block) => block.text || "").join(" ") : "";
}

async function recentHistory(root, query, currentSessionId) {
  const files = [];
  async function visit(directory, depth) {
    if (depth > 3 || files.length >= 200) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await visit(root, 0);
  const newest = (await Promise.all(files.map(async (path) => ({ path, info: await stat(path).catch(() => null) }))))
    .filter(({ info }) => info && info.size <= 1024 * 1024)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 100);
  const candidates = [];
  for (const { path, info } of newest) {
    if (!info || info.size > 1024 * 1024) continue;
    let cached = historyCache.get(path);
    if (!cached || cached.modified !== info.mtimeMs || cached.size !== info.size) {
      const raw = await readFile(path, "utf8").catch(() => "");
      const lines = raw.split("\n");
      let sessionId = "";
      try { sessionId = JSON.parse(lines[0]).id || ""; } catch { /* skip malformed header */ }
      const contents = [];
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== "message") continue;
        const content = extractText(entry.message).replace(/\s+/g, " ").trim();
        if (content) contents.push(content.slice(0, 500));
      }
      cached = { modified: info.mtimeMs, size: info.size, sessionId, contents };
      historyCache.set(path, cached);
    }
    if (cached.sessionId === currentSessionId) continue;
    for (const content of cached.contents) {
      const relevance = score(query, content);
      if (relevance) candidates.push({ relevance, modified: info.mtimeMs, content: content.slice(0, 500), sessionId: cached.sessionId });
    }
  }
  candidates.sort((a, b) => b.relevance - a.relevance || b.modified - a.modified);
  return candidates.slice(0, 3).map((item) => `[会话 ${item.sessionId.slice(0, 8)}] ${item.content}`);
}

export class MemoryStore {
  constructor(directory, sessionsDirectory) {
    this.path = join(directory, "memory.json");
    this.sessionsDirectory = sessionsDirectory;
    this.state = defaultState();
    this.persistence = Promise.resolve();
  }

  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!saved || typeof saved !== "object") throw new Error("记忆文件无效");
    this.state.enabled = Object.fromEntries(["l1", "l2", "l3", "work"].map((key) => [key, saved.enabled?.[key] !== false]));
    this.state.profile = typeof saved.profile === "string" ? saved.profile.slice(0, MAX_PROFILE) : "";
    this.state.facts = Array.isArray(saved.facts) ? saved.facts.slice(0, 40).filter((fact) => typeof fact.key === "string" && typeof fact.content === "string") : [];
    if (!this.state.facts.length && this.state.profile) this.state.facts.push({ key: "已有画像", content: this.state.profile, source: "legacy" });
    this.state.working = Array.isArray(saved.working) ? saved.working.filter(i=>["path","shell","workflow"].includes(i.kind)&&typeof i.title==="string"&&typeof i.body==="string").map(i=>({...i,id:typeof i.id==='string'?i.id:randomUUID(),status:i.status||'active',revision:i.revision||1,revisions:Array.isArray(i.revisions)?i.revisions:[]})) : [];
    this.state.notes = Array.isArray(saved.notes) ? saved.notes.filter((note) =>
      typeof note?.id === "string" && typeof note.title === "string" && typeof note.body === "string")
      .slice(0, MAX_NOTES).map((note) => ({ id: note.id, title: note.title.slice(0, 100), body: note.body.slice(0, MAX_NOTE_BODY), source: note.source, updated: note.updated, reviewOnly:note.reviewOnly===true,revisions:Array.isArray(note.revisions)?note.revisions:[] })) : [];
    for(const [list,key,body] of [["facts","key","content"],["notes","title","body"]]) {
      const merged=[];for(const item of this.state[list]){const old=merged.find(i=>similarTopic(i[key],item[key])&&(list!=="working"||(i.kind===item.kind&&workEnvironment(i)===workEnvironment(item))));if(old)Object.assign(old,{[body]:supplement(old[body],item[body],list==="notes"?MAX_NOTE_BODY:list==="working"?4000:700),updated:item.updated||old.updated});else merged.push(item);}this.state[list]=merged;
    }
    this.state.profile=this.state.facts.map(f=>`${f.key}：${f.content}`).join("\n").slice(0,MAX_PROFILE);
  }

  snapshot() {const current=list=>list.map(({revisions,...item})=>({...item,revisionCount:revisions?.length||0}));return structuredClone({...this.state,facts:current(this.state.facts),notes:current(this.state.notes),working:current(this.state.working)});}

  async persist() {
    const content = JSON.stringify(this.state, null, 2);
    const operation = this.persistence.catch(() => {}).then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, content, "utf8"); await rename(temporary, this.path);
    });
    this.persistence = operation; await operation;
  }

  async setEnabled(layer, enabled) {
    if (!["l1", "l2", "l3", "work"].includes(layer) || typeof enabled !== "boolean") throw new Error("无效的记忆开关");
    this.state.enabled[layer] = enabled;
    await this.persist();
  }

  async setProfile(profile) {
    if (typeof profile !== "string" || profile.length > MAX_PROFILE) throw new Error("学习者画像最多 6000 字");
    this.state.profile = profile.trim();
    this.state.facts = profile.trim() ? [{ key: "画像", content: profile.trim(), source: "user" }] : [];
    await this.persist();
  }

  async saveNote(input) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!title || title.length > 100 || !body || body.length > MAX_NOTE_BODY) throw new Error("标题或资料内容长度不合适");
    const existing = input.noteId ? this.state.notes.find((note) => note.id === input.noteId) : this.state.notes.find(note=>similarTopic(note.title,title));
    if (input.noteId && !existing) throw new Error("找不到该资料");
    if (!existing && this.state.notes.length >= MAX_NOTES) throw new Error("资料数量已达到上限");
    if (existing) {const revisions=[...(existing.revisions||[]),{body:existing.body,source:existing.source,updated:existing.updated}];Object.assign(existing, { title:input.noteId?title:existing.title, body:input.noteId?body:supplement(existing.body,body,MAX_NOTE_BODY),revisions });}
    else this.state.notes.push({ id: randomUUID(), title, body });
    await this.persist();
  }

  async deleteNote(id) {
    const count = this.state.notes.length;
    this.state.notes = this.state.notes.filter((note) => note.id !== id);
    if (count === this.state.notes.length) throw new Error("找不到该资料");
    await this.persist();
  }

  async applyAgentUpdate(update, source) {
    if(this.agentAllowed&&!this.agentAllowed(source))return;
    if (this.state.enabled.l1 && Array.isArray(update.facts)) {
      for (const fact of update.facts.slice(0, 8)) {
        if(isLearningGoal(fact?.key))continue;
        if (typeof fact?.key !== "string" || typeof fact?.content !== "string" || !fact.content.trim()) continue;
        const value = { key: fact.key.trim().slice(0, 80), content: fact.content.trim().slice(0, 600), source, updated: new Date().toISOString() };
        const candidate=this.state.facts.find(item=>similarTopic(item.key,value.key))||await this.matchTopic?.(value.key,this.state.facts,"key",value.content);
        if(this.agentAllowed&&!this.agentAllowed(source))return;
        const index = candidate?this.state.facts.indexOf(candidate):-1;
        if (index >= 0) {const old=this.state.facts[index];this.state.facts[index] = {...value,key:old.key,content:fact.operation==='replace'?value.content:supplement(old.content,value.content,600),revisions:[...(old.revisions||[]),{content:old.content,source:old.source,updated:old.updated,operation:fact.operation||'supplement'}]};}
        else if (this.state.facts.length < 40) this.state.facts.push(value);
        else throw Error('画像短记忆已满，请合并或纠正已有主题，不会静默丢弃');
      }
      this.state.profile = this.state.facts.map((fact) => `${fact.key}：${fact.content}`).join("\n").slice(0, MAX_PROFILE);
    }
    if (this.state.enabled.l2 && Array.isArray(update.notes)) {
      for (const note of update.notes.slice(0, 3)) {
        if (typeof note?.title !== "string" || typeof note?.body !== "string" || !note.body.trim()) continue;
        const title = note.title.trim().slice(0, 100);
        const existing = this.state.notes.find((item) => similarTopic(item.title,title))||await this.matchTopic?.(title,this.state.notes,"title",note.body);
        if(this.agentAllowed&&!this.agentAllowed(source))return;
        const value = { title, body: note.body.trim().slice(0, MAX_NOTE_BODY), source, updated: new Date().toISOString() };
        if (existing) {const revisions=[...(existing.revisions||[]),{body:existing.body,source:existing.source,updated:existing.updated}];Object.assign(existing, {...value,title:existing.title,body:note.operation==='replace'?value.body:supplement(existing.body,value.body,MAX_NOTE_BODY),revisions});}
        else if (this.state.notes.length < MAX_NOTES) this.state.notes.push({ id: randomUUID(), ...value });
        else throw Error('个人结论数量已满，请合并已有条目，不会静默丢弃');
      }
    }
    await this.persist();
  }

  async deleteWork(title,workId) {
    if(!workId&&this.state.working.filter(i=>i.title===title).length>1)throw Error("存在同名工作经验，请按条目删除");
    const removed=this.state.working.filter(i=>workId?i.id===workId:i.title===title);
    this.state.working=this.state.working.filter(i=>!removed.includes(i));await this.persist();await this.removeWorkIndex(removed.map(i=>i.id));
  }
  async removeWorkIndex(ids){
    const path=join(this.path,'..','local-search.sqlite');if(!await stat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))return;
    const index=new LocalSearchIndex(path);try{for(const id of ids)index.remove('work',id);}finally{index.close();}
  }
  async deleteFact(key) {
    this.state.facts = this.state.facts.filter((fact) => fact.key !== key);
    this.state.profile = this.state.facts.map((fact) => `${fact.key}：${fact.content}`).join("\n").slice(0, MAX_PROFILE);
    await this.persist();
  }

  async rememberWork(input,source,{allowed=()=>true}={}) {
    if(!this.state.enabled.work)return;
    if(!["path","shell","workflow"].includes(input.kind)||typeof input.title!=="string"||typeof input.body!=="string")throw Error("工作记忆格式无效");
    const operation=input.operation||'supplement';if(!['supplement','replace','invalidate'].includes(operation))throw Error('工作经验更新方式无效');
    if(operation!=='supplement'&&!input.targetId)throw Error('纠正或失效必须指定已有经验 ID');
    const value={kind:input.kind,title:input.title.slice(0,100),body:input.body.slice(0,700),...(typeof input.scope==='string'?{scope:input.scope}:{}),source,updated:new Date().toISOString()};
    for(const field of ['trigger','environment','steps','verification','invalidWhen','evidence'])if(typeof input[field]==='string')value[field]=input[field].slice(0,700);
    if(Array.isArray(input.validatedCommands))value.validatedCommands=input.validatedCommands.slice(0,12).map(s=>String(s).slice(0,700));
    if(Array.isArray(input.evidenceRefs))value.evidenceRefs=input.evidenceRefs.slice(0,12).map(({id,tool,ok,command,shell})=>({id,tool,ok,command,shell}));
    if(typeof input.verificationScope==='string')value.verificationScope=input.verificationScope;
    if(/api[_ -]?key|password|密码|令牌|secret|bearer\s/i.test(JSON.stringify(value)))throw Error("工作记忆不能保存凭据");
    const candidates=this.state.working.filter(i=>i.status!=='invalidated'&&i.kind===value.kind&&workEnvironment(i)===workEnvironment(value)&&sameEnvironment(i.environment,value.environment));
    const old=input.targetId?this.state.working.find(i=>i.id===input.targetId):candidates.find(i=>similarTopic(i.title,value.title))||await this.matchWorkTopic?.(value.title,candidates,"title",value.body);
    if(input.targetId&&(!old||old.kind!==value.kind||(old.scope||'')!==(value.scope||'')))throw Error('经验 ID 不存在或不属于当前项目/类型');
    if(old&&input.targetId&&operation==='supplement'&&(workEnvironment(old)!==workEnvironment(value)||!sameEnvironment(old.environment,value.environment)))throw Error('不同环境的方法不能直接补充到同一经验');
    if(old?.status==='invalidated'&&operation==='supplement')throw Error('已失效经验不能补充，请明确纠正并重新验证');
    if(!allowed()||!this.state.enabled.work||(this.workAllowed&&!this.workAllowed(source)))throw Error("工作记忆写入已关闭或轮次已改变");
    const body=old&&operation==='supplement'?supplement(old.body,value.body,Infinity):value.body;
    if(body.length>4000)throw Error("工作经验条目过长，需要先精简再补充");
    const revision=(old?.revision||0)+1,status=operation==='invalidate'?'invalidated':'active';
    const history=[...(old?.revisions||[])];if(old&&!history.length)history.push({revision:old.revision||1,operation:'legacy',body:old.body,source:old.source,time:old.updated});
    const corrections=operation==='replace'?{trigger:value.trigger||'',steps:value.steps||body,verification:value.verification||value.evidence||'',invalidWhen:value.invalidWhen||'',validatedCommands:value.validatedCommands||[],evidenceRefs:value.evidenceRefs||[],verificationScope:value.verificationScope||'legacy-unverified'}:{};
    history.push({...value,...corrections,revision,operation,body,evidence:value.evidence||'',source,time:value.updated});
    const record={...old,...value,...corrections,id:old?.id||randomUUID(),title:old?.title||value.title,body,status,revision,revisions:history};
    if(old)Object.assign(old,record);else this.state.working.push(record);
    await this.persist();
    if(status==='invalidated')await this.removeWorkIndex([record.id]);
    return {id:record.id,title:record.title,operation:old?operation:'create',revision,status};
  }

  async createWorkSkillDraft(id,scope=''){
    const current=this.workItems(scope).find(i=>i.id===id);if(!current)throw Error('未找到当前项目中有效的经验');const item=structuredClone(current);
    if(!item.verification&&!item.evidence)throw Error('缺少验证证据，先补充经验再生成技能草稿');
    const name=`work-${item.id.replace(/[^a-z0-9]/gi,'').slice(0,32).toLowerCase()}-r${item.revision||1}`;
    const dir=join(this.path,'..','skill-drafts',name,`revision-${item.revision||1}`);await mkdir(dir,{recursive:true});
    const body=`---\nname: ${name}\ndescription: ${JSON.stringify(item.title)}\nreed_experience_id: ${item.id}\nreed_experience_revision: ${item.revision||1}\n---\n\n# ${item.title}\n\n来源经验：${item.id}，修订 ${item.revision||1}。此文件是待审核草稿，启用前核对当前环境。\n\n## 适用条件\n${item.trigger||item.title}\n\n## 环境与范围\n${item.environment||'使用前确认工具与版本'}\n${item.scope||'通用方法，仍需确认环境'}\n\n## 操作步骤与已知陷阱\n${item.steps||item.body}\n\n## 验证办法\n${item.verification||item.evidence}\n\n## 失效条件\n${item.invalidWhen||'环境或工具版本改变、验证失败时停止套用，重新核对方法。'}\n`;
    const path=join(dir,'SKILL.md');try{await writeFile(path,body,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
    return {path,dir,body:await readFile(path,'utf8'),experienceId:item.id,revision:item.revision||1};
  }
  async recordWorkUse(event){
    if(!this.state.enabled.work)return;
    const record={time:new Date().toISOString(),kind:event.kind,ids:event.ids,basis:event.basis,source:event.source,outcome:event.outcome};
    const key=JSON.stringify([record.kind,record.ids,record.source,record.basis,record.outcome]);if(this.lastWorkUse===key)return;
    try{await appendFile(join(this.path,'..','work-usage.jsonl'),JSON.stringify(record)+'\n');this.lastWorkUse=key;}catch(error){this.auditError=error.message;}
  }
  workItems(scope=''){const normalize=s=>process.platform==='win32'?s.replaceAll('/','\\').toLowerCase():s;return this.state.enabled.work?this.state.working.filter(i=>i.status!=='invalidated'&&(!i.scope||normalize(i.scope)===normalize(scope||''))):[];}
  workMatches(query,scope='',shellHint=''){
    const allItems=this.workItems(scope),items=allItems.filter(i=>applicableWork(i,shellHint||query));if(!items.length)return [];
    let index;
    try{
      index=new LocalSearchIndex(join(this.path,'..','local-search.sqlite'));
      const scopes=[...new Set(allItems.map(i=>i.scope||''))];
      for(const group of scopes){const records=allItems.filter(i=>(i.scope||'')===group);for(const item of records)index.put({id:item.id,area:'work',scope:group,text:[item.title,item.body,item.trigger,item.steps,item.environment].join(' '),payload:{id:item.id},revision:String(item.revision||1)});index.retain('work',group,records.map(i=>i.id));}
      const hits=scopes.flatMap(group=>index.search('work',group,query,100)).sort((a,b)=>b.score-a.score);
      return hits.map(hit=>items.find(i=>i.id===hit.id)).filter(Boolean).slice(0,3);
    }catch(error){this.indexError=error.message;return items.map(i=>({i,score:score(query,[i.title,i.body,i.trigger,i.steps,i.environment].join(' '))})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3).map(({i})=>i);}
    finally{index?.close();}
  }
  workContext(query,scope=''){return this.workMatches(query,scope).map(i=>`[${i.id}] ${i.title}：${i.body.slice(0,700)}`).join("\n").slice(0,2600);}
  recallNotes(query,{review=false}={}){if(!this.state.enabled.l2)return [];return this.state.notes.filter(n=>(review||!(n.reviewOnly||reviewOnly(n.title+" "+n.body)))&&score(query,n.title+" "+n.body)>0).sort((a,b)=>score(query,b.title+" "+b.body)-score(query,a.title+" "+a.body)).slice(0,3);}
  async context(query, currentSessionId, {review=false,relevantOnly=false}={}) {
    const parts=[];
    if(this.state.enabled.l1){const facts=this.state.facts.filter(f=>!isLearningGoal(f.key)&&(review||!reviewOnly(f.key+" "+f.content))).map((f,index)=>({f,index,rank:score(query,f.key+' '+f.content)})).filter(item=>!relevantOnly||item.rank>0).sort((a,b)=>b.rank-a.rank||b.index-a.index).slice(0,4).map(({f})=>f);if(facts.length)parts.push("背景与偏好：\n"+facts.map(f=>`${f.key}：${f.content.slice(0,120)}`).join("\n"));}
    const notes=this.recallNotes(query,{review});if(notes.length)parts.push("相关资料索引（用 recall_memory 读取）："+notes.map(n=>n.title).join("、"));
    // Raw cross-session messages can reintroduce reviews and superseded facts.
    // They remain on disk, but are never automatically injected.
    return parts.join("\n\n").slice(0,900);
  }
}
