import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, copyFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { protectKey, unprotectKey } from "./endpoint.mjs";
import { LocalSearchIndex } from "./local-search.mjs";
import { setImmediate as yieldLoop } from 'node:timers/promises';

// Strip only a complete leading YAML block; preserve malformed or ordinary Markdown.
export function noteBody(text) { return String(text).replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,'').trimStart(); }

export function inside(root, path) { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); }
export function terms(text) { const s = String(text).toLowerCase(); return [...new Set([...(s.match(/[a-z0-9_]{2,}/g) || []), ...(s.match(/[\u3400-\u9fff]+/g) || []).flatMap(v => Array.from({length: Math.max(1,v.length-1)}, (_,i)=>v.slice(i,i+2)))])]; }
export async function walk(root, accept, budget = { files:0, bytes:0 }) {
  const found=[];
  async function visit(dir) {
    for (const item of await readdir(dir,{withFileTypes:true})) {
      if (item.isSymbolicLink() || [".git",".obsidian","node_modules"].includes(item.name)) continue;
      const path=join(dir,item.name);
      if(item.isDirectory()) { await visit(path); continue; }
      if(!item.isFile() || !accept(path)) continue;
      const info=await lstat(path); budget.files++; budget.bytes+=info.size;
      if(budget.files>10000 || budget.bytes>100*1024*1024) throw new Error("文件库超过轻量索引上限（1 万文件 / 100 MB），请选择较小的目录");
      found.push({path,size:info.size,mtime:info.mtimeMs,ctime:info.ctimeMs});
    }
  }
  await visit(root); return found;
}
export class CapabilityStore {
  constructor(dir,{encrypt=protectKey,decrypt=unprotectKey,config=null}={}) { this.dir=dir; this.config=config; this.path=join(dir,"capabilities.json"); this.encrypt=encrypt; this.decrypt=decrypt; this.state={skills:[],vaultPath:null,webEnabled:false,browserEnabled:true}; this.cache=new Map(); this.localSearch=null; this.key=""; this.noteScanStatus={state:"idle",checkedFiles:0,errorCount:0,errors:[]}; }
  async load() { try { Object.assign(this.state,this.config?await this.config.get("capabilities",this.path,this.state):JSON.parse(await readFile(this.path,"utf8"))); } catch(e) { if(e.code!=="ENOENT") throw e; } try { this.key=await this.decrypt(await this.encryptedKey()); } catch(e) { if(e.code!=="ENOENT") this.keyError="搜索凭据无法读取，请重新保存"; } }
  async encryptedKey(){const data=this.config?await this.config.read():{};if(data.credentials?.tavily)return data.credentials.tavily;const old=await readFile(join(this.dir,"tavily-key.dpapi"),"utf8");if(this.config)await this.config.update(d=>{d.credentials||={};d.credentials.tavily=old;});return old;}
  snapshot() { return {...this.state,hasSearchKey:!!this.key,keyError:this.keyError,noteScanStatus:this.noteScanStatus}; }
  async persist() { if(this.config){await this.config.set("capabilities",this.state);return;} await writeFile(this.path+".tmp",JSON.stringify(this.state,null,2)); await rename(this.path+".tmp",this.path); }
  async configure({vaultPath,webEnabled,browserEnabled,key}) {
    let selectedVault=this.state.vaultPath;
    if(vaultPath!==undefined) { selectedVault=vaultPath ? await realpath(vaultPath) : null; if(selectedVault && !(await lstat(selectedVault)).isDirectory()) throw new Error("请选择笔记目录"); }
    if(key!==undefined && key.trim()) { if(key.length>4096) throw new Error("Key 过长"); const encrypted=await this.encrypt(key.trim()); if(this.config)await this.config.update(d=>{d.credentials||={};d.credentials.tavily=encrypted;});else await writeFile(join(this.dir,"tavily-key.dpapi"),encrypted); this.key=key.trim(); this.keyError=null; }
    if(webEnabled!==undefined) this.state.webEnabled=!!webEnabled;
    if(browserEnabled!==undefined) this.state.browserEnabled=!!browserEnabled;
    if(vaultPath!==undefined) { this.state.vaultPath=selectedVault; this.cache.clear();this.noteScanStatus={state:"idle",checkedFiles:0,errorCount:0,errors:[]}; }
    await this.persist(); return this.snapshot();
  }
  async importSkill(source) {
    const root=await realpath(source), descriptor=join(root,"SKILL.md");
    const info=await lstat(descriptor); if(!info.isFile() || info.isSymbolicLink() || info.size>100000) throw new Error("请选择包含 SKILL.md 的技能目录");
    const text=await readFile(descriptor,"utf8");
    const name=text.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || basename(root);
    const description=text.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1]?.trim() || "自定义技能";
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("技能名称须为小写字母、数字或连字符，最长 64 字符");
    if(this.state.skills.some(s=>s.name===name)) throw new Error("同名技能已导入");
    const files=await walk(root,()=>true,{files:0,bytes:0});
    if(files.length>500 || files.reduce((n,f)=>n+f.size,0)>10*1024*1024) throw new Error("单个技能最多 500 文件 / 10 MB");
    const id=randomUUID(), target=join(this.dir,"skills",id);
    for(const file of files) { const dest=join(target,relative(root,file.path)); await mkdir(resolve(dest,".."),{recursive:true}); await copyFile(file.path,dest); }
    const experienceId=text.match(/^reed_experience_id:\s*([a-z0-9-]+)\s*$/mi)?.[1],experienceRevision=Number(text.match(/^reed_experience_revision:\s*(\d+)\s*$/m)?.[1]);
    this.state.skills.push({id,name,description:description.slice(0,1000),path:target,enabled:true,...(experienceId&&Number.isSafeInteger(experienceRevision)?{experienceId,experienceRevision}:{})}); await this.persist(); return id;
  }
  async toggleSkill(id,enabled) { const s=this.state.skills.find(s=>s.id===id); if(!s) throw new Error("技能不存在"); s.enabled=!!enabled; await this.persist(); }
  enabledSkills() { return this.state.skills.filter(s=>s.enabled&&(!this.canUseSkill||this.canUseSkill(s))).map(s=>s.path); }
  async browseNotes(offset=0) {
    if(!this.state.vaultPath)return {results:[],next:null,total:0};
    if(!Number.isSafeInteger(offset)||offset<0)throw Error("浏览位置无效");
    const root=this.state.vaultPath,files=(await walk(root,p=>extname(p).toLowerCase()===".md"&&basename(p)!=="Reed-笔记库总览.md")).sort((a,b)=>relative(root,a.path).localeCompare(relative(root,b.path),"zh-CN"));
    const readable=[];for(const file of files)if(file.size<=1024*1024&&(!this.canRead||await this.canRead(file.path)))readable.push(file);
    const results=[];for(const file of readable.slice(offset,offset+5)){const body=await readFile(file.path,"utf8");results.push({path:file.path,title:relative(root,file.path),content:noteBody(body).slice(0,1200),url:`summon-file:${encodeURIComponent(file.path)}`});}
    return {results,total:readable.length,next:offset+results.length<readable.length?offset+results.length:null};
  }
  async searchNotes(query,limit=4,{signal}={}) {
    signal?.throwIfAborted();
    const queued=performance.now();
    const operation=(this.searchQueue||Promise.resolve()).catch(()=>{}).then(()=>this.searchNotesOnce(query,limit,{signal}));
    this.searchQueue=operation;const results=await operation;this.noteScanStatus.totalMs=Math.round(performance.now()-queued);return results;
  }
  async searchNotesOnce(query,limit=4,{signal}={}) {
    signal?.throwIfAborted();
    if(!this.state.vaultPath) { this.noteScanStatus={state:"idle",checkedFiles:0,errorCount:0,errors:[]};return []; }
    const needles=terms(query);if(!needles.length)return [];
    const started=performance.now(),root=this.state.vaultPath, files=[];
    const status={state:"complete",checkedFiles:0,errorCount:0,errors:[]};
    const confirmedIds=new Set();
    const fail=(path,error)=>{status.state="incomplete";status.errorCount++;if(status.errors.length<20)status.errors.push({path,message:error?.message||String(error)});};
    const visit=async dir=>{
      signal?.throwIfAborted();
      let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){fail(dir,error);return;}
      for(const item of entries){
        signal?.throwIfAborted();
        if(status.budgetStopped)return;
        if(item.isSymbolicLink()||[".git",".obsidian","node_modules"].includes(item.name))continue;
        const path=join(dir,item.name);
        if(item.isDirectory()){await visit(path);if(status.budgetStopped)return;continue;}
        if(!item.isFile()||extname(path).toLowerCase()!==".md"||basename(path)==="Reed-笔记库总览.md")continue;
        try{const info=await lstat(path);status.filesSeen=(status.filesSeen||0)+1;status.bytes=(status.bytes||0)+info.size;if(status.filesSeen>10000||status.bytes>100*1024*1024){status.budgetStopped=true;fail(path,new Error("扫描预算中止（1 万文件 / 100 MB）"));return;}files.push({path,size:info.size,mtime:info.mtimeMs,ctime:info.ctimeMs});}
        catch(error){fail(path,error);}
      }
    };
    await visit(root);delete status.bytes;delete status.filesSeen;delete status.budgetStopped;
    const scanned=performance.now();status.timings={scanMs:Math.round(scanned-started)};
    const activeIds=[];
    try{
    if(!this.localSearch)this.localSearch=new LocalSearchIndex(join(this.dir,"local-search.sqlite"));
    const revisions=new Map();
    for(const item of this.localSearch.list('notes',root)){const prefix=item.id.slice(0,item.id.indexOf(':')+1);if(!revisions.has(prefix))revisions.set(prefix,[]);revisions.get(prefix).push(item);}
    for(const file of files) {
      await yieldLoop();
      signal?.throwIfAborted();
      status.checkedFiles++;
      if(this.canRead){try{if(!(await this.canRead(file.path))){fail(file.path,new Error("读取权限被拒绝"));continue;}}catch(error){fail(file.path,error);continue;}}
      if(file.size>1024*1024) continue;
      const name=relative(root,file.path),prefix=`${createHash("sha256").update(name).digest("hex")}:`;
      const revision=`${file.size}:${file.mtime}:${file.ctime}`;
      const previous=revisions.get(prefix)||[];
      if(previous.length&&previous.every(item=>item.revision===revision)){activeIds.push(...previous.map(item=>item.id));previous.forEach(item=>confirmedIds.add(item.id));continue;}
      let body;try{body=await readFile(file.path,"utf8");}catch(error){fail(file.path,error);continue;}
      const lines=body.split(/\r?\n/);
      let heading="",start=0;const pending=[];
      for(let i=0;i<=lines.length;i++) {
        if(i===lines.length || /^#{1,6}\s/.test(lines[i]) || (i>start && !lines[i].trim()) || i-start>=30) {
          let first=start,last=i; while(first<last && !lines[first].trim())first++; while(last>first && !lines[last-1].trim())last--;
          const content=lines.slice(first,last).join("\n").trim();
          if(content) {
            const id=`${prefix}${first+1}`;
            const payload={heading,startLine:first+1,endLine:last,content:content.slice(0,4000),path:file.path,title:name,url:`summon-file:${encodeURIComponent(file.path)}#L${first+1}`};
            pending.push({id,area:"notes",scope:root,text:`${name}\n${heading}\n${content.slice(0,4000)}`,payload,revision});
            activeIds.push(id);confirmedIds.add(id);
          }
          if(i<lines.length && /^#{1,6}\s/.test(lines[i])) heading=lines[i].replace(/^#+\s*/,""); start=i;
        }
      }
      for(let offset=0;offset<pending.length;offset+=32){await yieldLoop();signal?.throwIfAborted();this.localSearch.transaction(()=>{for(const record of pending.slice(offset,offset+32))this.localSearch.put(record);});}
    }
    signal?.throwIfAborted();
    if(status.state==="complete")this.localSearch.retain("notes",root,activeIds);
    const indexed=performance.now();status.timings.indexMs=Math.round(indexed-scanned);
    this.noteScanStatus=status;
    if(!terms(query).length)return [];
    const hits=this.localSearch.search("notes",root,query,Math.min(100,Math.max(1,limit*4))).filter(hit=>confirmedIds.has(hit.id)).slice(0,Math.min(8,Math.max(1,limit))).map(hit=>({...hit.payload,score:hit.score}));
    status.timings.ftsMs=Math.round(performance.now()-indexed);return hits;
    }catch(error){if(signal?.aborted)throw signal.reason;fail(root,error);this.noteScanStatus=status;return [];
    }finally{this.close();}
  }
  close() {
    this.localSearch?.close();
    this.localSearch=null;
  }
  async resolveFile(input,workspace) {
    let raw=String(input); if(raw.startsWith("summon-file:")) raw=decodeURIComponent(raw.slice(12).split("#")[0]); else if(raw.startsWith("file:")) raw=decodeURIComponent(new URL(raw).pathname).replace(/^\/(?=[A-Za-z]:)/,""); else raw=decodeURIComponent(raw.split("#")[0]);
    const path=await realpath(resolve(workspace,raw)), roots=[workspace,this.state.vaultPath,join(this.dir,"attachments")].filter(Boolean);
    if(!roots.some(r=>inside(r,path)) || !(await lstat(path)).isFile()) throw new Error("文件不在当前项目、笔记库或附件目录内");
    if(![".html",".htm",".md",".txt",".pdf",".png",".jpg",".jpeg",".svg",".csv"].includes(extname(path).toLowerCase())) throw new Error("此文件类型不支持直接打开"); return path;
  }
}
