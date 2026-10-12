import { similarTopic, supplement, reviewOnly } from "./memory-match.mjs";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_PROFILE = 6000;
const MAX_NOTES = 100;
const MAX_NOTE_BODY = 20000;
const defaultState = () => ({ enabled: { l1: true, l2: true, l3: true, work:true }, profile: "", facts: [], notes: [], working: [] });
const historyCache = new Map();

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
    this.state.working = Array.isArray(saved.working) ? saved.working.filter(i=>["path","shell","workflow"].includes(i.kind)&&typeof i.title==="string"&&typeof i.body==="string").slice(-50) : [];
    this.state.notes = Array.isArray(saved.notes) ? saved.notes.filter((note) =>
      typeof note?.id === "string" && typeof note.title === "string" && typeof note.body === "string")
      .slice(0, MAX_NOTES).map((note) => ({ id: note.id, title: note.title.slice(0, 100), body: note.body.slice(0, MAX_NOTE_BODY), source: note.source, updated: note.updated, reviewOnly:note.reviewOnly===true })) : [];
    for(const [list,key,body] of [["facts","key","content"],["notes","title","body"],["working","title","body"]]) {
      const merged=[];for(const item of this.state[list]){const old=merged.find(i=>similarTopic(i[key],item[key])&&(list!=="working"||i.kind===item.kind));if(old)Object.assign(old,{[body]:supplement(old[body],item[body],list==="notes"?MAX_NOTE_BODY:700),updated:item.updated||old.updated});else merged.push(item);}this.state[list]=merged;
    }
    this.state.profile=this.state.facts.map(f=>`${f.key}：${f.content}`).join("\n").slice(0,MAX_PROFILE);
  }

  snapshot() { return structuredClone(this.state); }

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
    if (existing) Object.assign(existing, { title:input.noteId?title:existing.title, body:input.noteId?body:supplement(existing.body,body,MAX_NOTE_BODY) });
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
        if (typeof fact?.key !== "string" || typeof fact?.content !== "string" || !fact.content.trim()) continue;
        const value = { key: fact.key.trim().slice(0, 80), content: fact.content.trim().slice(0, 600), source, updated: new Date().toISOString() };
        const candidate=this.state.facts.find(item=>similarTopic(item.key,value.key))||await this.matchTopic?.(value.key,this.state.facts,"key",value.content);
        if(this.agentAllowed&&!this.agentAllowed(source))return;
        const index = candidate?this.state.facts.indexOf(candidate):-1;
        if (index >= 0) this.state.facts[index] = {...value,key:this.state.facts[index].key,content:supplement(this.state.facts[index].content,value.content,600)};
        else if (this.state.facts.length < 40) this.state.facts.push(value);
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
        if (existing) Object.assign(existing, {...value,title:existing.title,body:supplement(existing.body,value.body,MAX_NOTE_BODY)});
        else if (this.state.notes.length < MAX_NOTES) this.state.notes.push({ id: randomUUID(), ...value });
      }
    }
    await this.persist();
  }

  async deleteWork(title) {this.state.working=this.state.working.filter(i=>i.title!==title);await this.persist();}
  async deleteFact(key) {
    this.state.facts = this.state.facts.filter((fact) => fact.key !== key);
    this.state.profile = this.state.facts.map((fact) => `${fact.key}：${fact.content}`).join("\n").slice(0, MAX_PROFILE);
    await this.persist();
  }

  async rememberWork(input,source) {
    if(!this.state.enabled.work)return;
    if(!["path","shell","workflow"].includes(input.kind)||typeof input.title!=="string"||typeof input.body!=="string")throw Error("工作记忆格式无效");
    const value={kind:input.kind,title:input.title.slice(0,100),body:input.body.slice(0,700),source,updated:new Date().toISOString()};
    if(/api[_ -]?key|password|密码|令牌|secret|bearer\s/i.test(value.body))throw Error("工作记忆不能保存凭据");
    const old=this.state.working.find(i=>i.kind===value.kind&&similarTopic(i.title,value.title))||await this.matchWorkTopic?.(value.title,this.state.working.filter(i=>i.kind===value.kind),"title",value.body);
    if(!this.state.enabled.work||(this.workAllowed&&!this.workAllowed(source)))throw Error("工作记忆写入已关闭");
    if(old)Object.assign(old,{...value,title:old.title,body:supplement(old.body,value.body,700)});else{this.state.working.push(value);this.state.working=this.state.working.slice(-50);}
    await this.persist();
  }
  workContext(query){if(!this.state.enabled.work)return "";return this.state.working.map(i=>({i,score:score(query,i.title+" "+i.body)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3).map(({i})=>`${i.title}：${i.body.slice(0,240)}`).join("\n").slice(0,800);}
  recallNotes(query,{review=false}={}){if(!this.state.enabled.l2)return [];return this.state.notes.filter(n=>(review||!(n.reviewOnly||reviewOnly(n.title+" "+n.body)))&&score(query,n.title+" "+n.body)>0).sort((a,b)=>score(query,b.title+" "+b.body)-score(query,a.title+" "+a.body)).slice(0,3);}
  async context(query, currentSessionId, {review=false}={}) {
    const parts=[];
    if(this.state.enabled.l1){const facts=this.state.facts.filter(f=>review||!reviewOnly(f.key+" "+f.content)).slice(-4);if(facts.length)parts.push("背景与偏好：\n"+facts.map(f=>`${f.key}：${f.content.slice(0,120)}`).join("\n"));}
    const notes=this.recallNotes(query,{review});if(notes.length)parts.push("相关资料索引（用 recall_memory 读取）："+notes.map(n=>n.title).join("、"));
    // Raw cross-session messages can reintroduce reviews and superseded facts.
    // They remain on disk, but are never automatically injected.
    return parts.join("\n\n").slice(0,900);
  }
}
