import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile, realpath, stat, rm } from "node:fs/promises";
import { join, dirname, resolve, relative, extname } from "node:path";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';

const MAX_IMAGE_BYTES=5*1024*1024, MAX_PIXELS=12*1024*1024;
export function captureOptions(input) {
  const viewport=input.viewport || {width:1280,height:800};
  if(!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width<320 || viewport.width>2560 || viewport.height<240 || viewport.height>2160) throw new Error("视口须为 320–2560 × 240–2160 的整数像素");
  const waitMs=input.waitMs ?? 0;
  if(!Number.isInteger(waitMs) || waitMs<0 || waitMs>10000) throw new Error("等待时间须为 0–10000 毫秒");
  if(input.fullPage!==undefined && typeof input.fullPage!=="boolean") throw new Error("fullPage 必须为布尔值");
  return {viewport,waitMs,fullPage:input.fullPage===true};
}

// Own, isolated Edge profile; starts only when the agent uses the browser.
export class AgentBrowser {
  constructor(dir,{scope,native,surface='agent'}={}) { this.dir=dir; this.scope=scope; this.previewServers=new Map();this.native=native;this.surface=surface;this.nativeReady=false;this.starting=null;this.startFailure=null; this.sequence=0; this.pending=new Map(); this.viewport={width:1280,height:800}; this.operations=Promise.resolve(); this.generation=0; this.queued=0; }
  localPath(url){
    try{const u=new URL(url);for(const [root,entry] of this.previewServers){const base=new URL(entry.base);if(u.origin!==base.origin||!u.pathname.startsWith(base.pathname))continue;const path=resolve(root,decodeURIComponent(u.pathname.slice(base.pathname.length))),rel=relative(root,path);if(rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../'))return path;}}catch{}return null;
  }
  async preview(path) {
    if(!this.scope) throw new Error("本地预览需要文件访问授权");
    const file=await realpath(await this.scope.check(path,false));
    if(![".html",".htm"].includes(extname(file).toLowerCase()) || !(await stat(file)).isFile()) throw new Error("本地预览只支持 HTML 文件");
    // Reuse the running server for the same file. A model can keep the preview URL
    // (with query parameters) across slow thinking turns; a fresh port/token would
    // make that URL unreachable.
    const root=dirname(file),cached=this.previewServers.get(root);
    if(cached){
      this.previewRevision={path:file,mtimeMs:(await stat(file)).mtimeMs,sha256:createHash("sha256").update(await readFile(file)).digest("hex")};
      this.previewPath=file;this.previewServer=cached.server;this.previewUrl=cached.base+encodeURIComponent(relative(root,file));
      return this.previewUrl;
    }
    const token=randomUUID();
    const server=createServer(async(req,res)=>{
      try {
        if(req.method!=="GET" && req.method!=="HEAD") {res.writeHead(405);res.end();return;}
        const url=new URL(req.url,"http://127.0.0.1"),prefix=`/${token}/`;
        if(!url.pathname.startsWith(prefix)) throw new Error("无效预览路径");
        const requested=decodeURIComponent(url.pathname.slice(prefix.length));
        const candidate=await realpath(await this.scope.check(resolve(root,requested),false));
        const rel=relative(root,candidate);
        if(rel===".." || rel.startsWith(`..\\`) || rel.startsWith("../") || resolve(root,rel)!==candidate) throw new Error("文件不在预览目录内");
        const info=await stat(candidate);if(!info.isFile() || info.size>256*1024*1024) throw new Error("资源超过 256 MB 或不是文件");
        const mime={".html":"text/html; charset=utf-8",".htm":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".json":"application/json",".woff":"font/woff",".woff2":"font/woff2"}[extname(candidate).toLowerCase()] || "application/octet-stream";
        res.writeHead(200,{"Content-Type":mime,"Content-Length":info.size,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
        if(req.method==='HEAD')res.end();else await pipeline(createReadStream(candidate),res);
      }catch {if(res.headersSent){res.destroy();return;}res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end("资源不可读取（文件不存在、超出256 MB或没有访问权限）");}
    });
    await new Promise((res,rej)=>{server.once("error",rej);server.listen(0,"127.0.0.1",res);});
    this.previewServer=server;this.previewPath=file;
    this.previewRevision={path:file,mtimeMs:(await stat(file)).mtimeMs,sha256:createHash("sha256").update(await readFile(file)).digest("hex")};
    this.previewUrl=`http://127.0.0.1:${server.address().port}/${token}/${encodeURIComponent(relative(root,file))}`;
    this.previewServers.set(root,{server,base:`http://127.0.0.1:${server.address().port}/${token}/`});
    return this.previewUrl;
  }
  async start() {
    if(this.native){
      if(this.nativeReady)return;
      if(this.starting)return this.starting;
      if(this.startFailure)throw this.startFailure;
      const generation=this.generation;
      this.starting=this.native.request(this.surface,'ensure').then(async info=>{
        if(generation!==this.generation)throw Error('浏览器操作已取消');
        this.nativeReady=true;this.startup=info;await this.call('Page.enable');
      }).catch(error=>{this.nativeReady=false;if(generation===this.generation)this.startFailure=error;throw error;}).finally(()=>{this.starting=null;});
      return this.starting;
    }
    if(process.env.SUMMON_NATIVE_BROWSER==='1')throw Error('内置浏览器连接不可用，不会启动系统Edge');
    if(this.socket?.readyState===1) return;
    const candidates=[process.env.PROGRAMFILES,process.env["PROGRAMFILES(X86)"],process.env.LOCALAPPDATA].filter(Boolean).map(p=>join(p,"Microsoft","Edge","Application","msedge.exe"));
    let executable; for(const path of candidates) { if(await access(path).then(()=>true,()=>false)) { executable=path; break; } }
    if(!executable) throw new Error("未找到 Microsoft Edge，请安装后使用浏览器工具");
    const profile=join(this.dir,`browser-${process.pid}-${randomUUID()}`); await mkdir(profile,{recursive:true});
    this.profile=profile;
    // msedge.exe hands off to a separate browser process and the launcher exits
    // immediately on Windows. Its exit is normal, not a startup failure, and the
    // profile must survive until the real browser has been closed.
    this.child=spawn(executable,["--headless=new","--remote-debugging-port=0",`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","about:blank"],{windowsHide:true,stdio:"ignore"});
    const ownedChild=this.child, generation=this.generation;
    let launchError; this.child.once("error",e=>{launchError=e;});
    try {
      let port;
      for(let i=0;i<150;i++) { if(launchError) throw launchError; if(generation!==this.generation) throw new Error("浏览器操作已取消"); try { port=Number((await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]); if(port) break; } catch {} await new Promise(r=>setTimeout(r,100)); }
      if(!port) throw new Error("浏览器启动超时：15 秒内没有拿到调试端口");
      const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(5000)}); const version=await response.json();
      this.socket=new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((res,rej)=>{ const timer=setTimeout(()=>rej(new Error("浏览器连接超时")),5000); this.socket.addEventListener("open",()=>{clearTimeout(timer);res();},{once:true}); this.socket.addEventListener("error",()=>{clearTimeout(timer);rej(new Error("浏览器连接失败"));},{once:true}); });
      this.socket.addEventListener("message",e=>{ const msg=JSON.parse(e.data); const req=this.pending.get(msg.id); if(req) { this.pending.delete(msg.id); clearTimeout(req.timer); msg.error ? req.reject(new Error(msg.error.message)) : req.resolve(msg.result); } });
      const ownedSocket=this.socket;
      this.socket.addEventListener("close",()=>{ if(this.socket && this.socket!==ownedSocket)return; for(const req of this.pending.values()) {clearTimeout(req.timer);req.reject(new Error("浏览器已断开"));} this.pending.clear(); this.sessionId=null; });
      const target=await this.call("Target.createTarget",{url:"about:blank"}); const attached=await this.call("Target.attachToTarget",{targetId:target.targetId,flatten:true}); this.sessionId=attached.sessionId;
      await this.call("Page.enable");
    } catch(e) {
      if(this.child===ownedChild)this.close();
      if(e.message==="fetch failed")throw new Error(`无法连接本次启动的 Edge 调试服务（${e.cause?.code||"连接失败"}）；请报告环境问题，不要重复调用同一操作`);
      throw e;
    }
  }
  call(method,params={}) { if(this.native)return this.native.request(this.surface,method,params); const id=++this.sequence; return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("浏览器操作超时"));},15000); this.pending.set(id,{resolve,reject,timer}); try{this.socket.send(JSON.stringify({id,method,params,...(this.sessionId?{sessionId:this.sessionId}:{})}));}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);} }); }
  async evaluate(expression) { const r=await this.call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails) throw new Error(`网页操作失败：${String(r.exceptionDetails.exception?.description||r.exceptionDetails.text||"未知错误").split("\n")[0].slice(0,300)}`); return r.result.value; }
  async navigate(url) {
    const navigation=await this.call("Page.navigate",{url});
    if(navigation.errorText) throw new Error(navigation.errorText);
    await this.waitForDocument({loaderId:navigation.loaderId,url:navigation.loaderId?undefined:url});
  }
  async waitForDocument({loaderId,previousLoader,url}={}) {
    // Page.navigate may resolve while the previous document is still visible.
    // Confirm the new loader before accepting readyState from its document.
    const deadline=Date.now()+20000;
    while(Date.now()<deadline) {
      const tree=await this.call("Page.getFrameTree");
      if((!loaderId || tree.frameTree.frame.loaderId===loaderId)&&(!previousLoader||tree.frameTree.frame.loaderId!==previousLoader)) {
        try {if(await this.evaluate(`document.readyState!=='loading' && !!document.body${url?' && location.href==='+JSON.stringify(url):''}`)) {
          await this.evaluate("(async()=>{await Promise.race([document.fonts?.ready||Promise.resolve(),new Promise(r=>setTimeout(r,2000))]);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()");return;
        }} catch {}
      }
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error("页面加载超时（20 秒），请确认本地资源或网页可访问后重试");
  }
  run(input,{signal}={}) {
    if(signal?.aborted)return Promise.reject(new Error("浏览器操作已取消"));
    if(this.queued>=20) return Promise.reject(new Error("浏览器待处理操作过多，请等待当前操作完成"));
    const generation=this.generation; this.queued++;
    const operation=this.operations.then(async()=>{
      if(generation!==this.generation) throw new Error("浏览器操作已取消");
      if(signal?.aborted)throw new Error("浏览器操作已取消");
      const abort=()=>this.cancel();signal?.addEventListener("abort",abort,{once:true});
      const started=performance.now(),reused=this.native?this.nativeReady:this.socket?.readyState===1;
      try{const result=await this.runOne(input,signal);result.details={...result.details,engine:this.native?'webview2':'edge',durationMs:Math.round(performance.now()-started),reused};return result;}catch(error){if(signal?.aborted){throw new Error("浏览器操作已取消");}throw error;}finally{signal?.removeEventListener("abort",abort);}

    });
    this.operations=operation.catch(()=>{});
    return operation.finally(()=>{this.queued--;});
  }
  async runOne(input,signal) {
    const {action,url,index,text,path}=input;
    if(!["navigate","preview","snapshot","screenshot","click","fill","back","forward","reload","read_page"].includes(action)) throw new Error("未知浏览器操作");
    // The visible pane can be narrower than the explicit emulation minimum.
    // Validate requested viewports, then read the actual preview dimensions.
    const options=captureOptions({...input,viewport:input.viewport || (this.surface==='preview'?{width:1280,height:800}:this.viewport)});
    let destination;
    if(action==="navigate") {const u=new URL(url);if(!["http:","https:"].includes(u.protocol) || u.username || u.password) throw new Error("浏览器只接受 HTTP(S) 地址；本地 HTML 请使用 preview");destination=u.href;}
    if(action==="preview") destination=await this.preview(path);
    if(destination&&action==='preview'){
      const address=new URL(destination);
      for(const field of ['search','hash'])if(input[field]!==undefined){if(typeof input[field]!=='string'||input[field].length>4000)throw Error('本地页面位置无效');address[field]=input[field];}
      destination=address.href;
    }
    if(signal?.aborted)throw new Error("浏览器操作已取消");
    await this.start();
    this.viewport=options.viewport;
    if(this.surface!=='preview')await this.call("Emulation.setDeviceMetricsOverride",{...this.viewport,deviceScaleFactor:1,mobile:false});
    else this.viewport=await this.evaluate('({width:innerWidth,height:innerHeight})');
    if(destination) {await this.navigate(destination); this.loadedAt=new Date().toISOString(); }
    if(action==='reload'){const before=await this.call('Page.getFrameTree');await this.call('Page.reload');await this.waitForDocument({previousLoader:before.frameTree.frame.loaderId});}
    if(action==='back'||action==='forward'){
      const history=await this.call('Page.getNavigationHistory'),entry=history.entries[history.currentIndex+(action==='back'?-1:1)];
      if(entry){await this.call('Page.navigateToHistoryEntry',{entryId:entry.id});await this.waitForDocument({url:entry.url});}
    }
    if(action==='read_page')return this.readPage(input,signal);
    if(action==="click" || action==="fill") {
      if(!Number.isInteger(index) || index<1) throw new Error("请使用最近快照中的元素编号");
      await this.evaluate(`(()=>{const e=document.querySelector('[data-summon-element="${index}"]'); if(!e) throw Error('元素已失效，请刷新快照'); ${action==="click" ? "e.click();" : `if(!('value' in e)) throw Error('不是输入框'); const setter=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set; if(setter) setter.call(e,${JSON.stringify(String(text||"").slice(0,10000))}); else e.value=${JSON.stringify(String(text||"").slice(0,10000))}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));`} return true;})()`);
    }
    if(options.waitMs) await new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(new Error("浏览器操作已取消"));};
      const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},options.waitMs);
      signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    });
    if(action==="screenshot") {
      const metrics=await this.call("Page.getLayoutMetrics");
      const size=options.fullPage?(metrics.cssContentSize || metrics.contentSize):this.viewport;
      const width=Math.ceil(size.width),height=Math.ceil(size.height);
      if(width>4096 || height>8192 || width*height>MAX_PIXELS) throw new Error("完整页面截图过大，请缩小页面或使用视口截图");
      const capturedUrl=await this.evaluate("location.href");
      const y=options.fullPage?0:await this.evaluate('scrollY');
      const r=await this.call("Page.captureScreenshot",{format:"png",captureBeyondViewport:options.fullPage,clip:{x:0,y,width,height,scale:1}});
      if(capturedUrl!==await this.evaluate("location.href")) throw new Error("截图期间页面发生导航，请重新截图");
      const png=Buffer.from(r.data,"base64");if(png.length>MAX_IMAGE_BYTES) throw new Error("截图超过 5 MB，请缩小截图范围");
      const pixelWidth=png.readUInt32BE(16),pixelHeight=png.readUInt32BE(20);
      if(pixelWidth>4096||pixelHeight>8192||pixelWidth*pixelHeight>MAX_PIXELS)throw Error('截图像素过大，请使用视口截图或分段读取');
      const capturedAt=new Date().toISOString(),artifactDir=join(this.dir,"artifacts","screenshots");await mkdir(artifactDir,{recursive:true});
      const artifactPath=join(artifactDir,`${Date.now()}-${randomUUID()}.png`);await writeFile(artifactPath,png,{flag:"wx"});
      const currentLocation=new URL(capturedUrl),previewLocation=this.previewUrl?new URL(this.previewUrl):null;
      const samePreview=!!this.previewPath && previewLocation?.origin===currentLocation.origin && previewLocation?.pathname===currentLocation.pathname;
      const revision=samePreview?this.previewRevision:null;
      const sourceChanged=revision?createHash("sha256").update(await readFile(revision.path)).digest("hex")!==revision.sha256:false;
      const details={artifactPath,mimeType:"image/png",width:pixelWidth,height:pixelHeight,cssWidth:width,cssHeight:height,bytes:png.length,capturedAt,loadedAt:this.loadedAt || null,viewport:this.viewport,waitMs:options.waitMs,fullPage:options.fullPage,sourcePath:samePreview?this.previewPath:null,sourceHash:revision?.sha256 || null,revision,sourceChanged,url:capturedUrl};
      return {content:[{type:"image",data:r.data,mimeType:"image/png"},{type:"text",text:JSON.stringify(details)}],details};
    }
    const snapshot=await this.evaluate(`(()=>{const elements=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).slice(0,150); document.querySelectorAll('[data-summon-element]').forEach(e=>e.removeAttribute('data-summon-element')); const controls=elements.map((e,i)=>{e.setAttribute('data-summon-element',String(i+1));return {index:i+1,tag:e.tagName,label:(e.innerText||e.getAttribute('aria-label')||e.placeholder||e.type||'').slice(0,150),href:e.href};}); return {url:location.href,title:document.title,text:document.body.innerText.slice(0,14000),controls};})()`);
    if(this.native){const history=await this.call('Page.getNavigationHistory');snapshot.navigation={canBack:history.currentIndex>0,canForward:history.currentIndex<history.entries.length-1};}
    snapshot.localPath=this.localPath(snapshot.url);
    return {content:[{type:"text",text:JSON.stringify(snapshot)}],details:{url:snapshot.url,localPath:snapshot.localPath}};
  }
  async readPage(input,signal){
    const limit=input.maxSegments??8;
    if(!Number.isInteger(limit)||limit<1||limit>12)throw Error('网页读取分段数须为1–12');
    const startY=input.startY??0,textOffset=input.textOffset??0;
    if(!Number.isInteger(startY)||startY<0||startY>1000000||!Number.isInteger(textOffset)||textOffset<0||textOffset>2000000)throw Error('网页续读位置无效');
    const origin=await this.evaluate('({url:location.href,x:scrollX,y:scrollY})');
    const content=[],captures=[];let covered=startY,lastHeight=0,complete=false;
    try{
      for(let index=0;index<limit;index++){
        signal?.throwIfAborted();
        await this.evaluate(`scrollTo(0,${covered})`);
        await this.evaluate("(async()=>{const visible=[...document.images].filter(i=>{const r=i.getBoundingClientRect();return !i.complete&&r.bottom>0&&r.top<innerHeight;});await Promise.race([Promise.all(visible.map(i=>new Promise(r=>{i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true});}))),new Promise(r=>setTimeout(r,1500))]);await new Promise(r=>setTimeout(r,150));return true;})()");
        const state=await this.evaluate('({url:location.href,top:scrollY,height:innerHeight,total:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)})');
        if(state.url!==origin.url)throw Error('网页在读取期间发生导航，请重新读取');
        if(input.includeImages){
          const shot=await this.runOne({action:'screenshot'},signal);content.push(shot.content[0]);captures.push({...shot.details,index:index+1,scrollY:state.top});
        }
        covered=Math.max(covered,state.top+state.height);lastHeight=state.total;
        if(covered>=state.total){
          await new Promise(resolve=>setTimeout(resolve,150));
          const height=await this.evaluate('Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)');
          if(height<=covered){complete=true;break;}
        }
      }
      const page=await this.evaluate(`(()=>{const text=document.body.innerText;return {url:location.href,title:document.title,text:text.slice(${textOffset},${textOffset+40000}),textCharacters:text.length,headings:[...document.querySelectorAll('h1,h2,h3')].slice(0,100).map(e=>({level:e.tagName,text:e.innerText})),links:[...document.querySelectorAll('a[href]')].slice(0,150).map(e=>({text:e.innerText.slice(0,160),url:e.href})),frames:document.querySelectorAll('iframe,frame').length,selection:getSelection()?.toString()||''};})()`);
      const textTruncated=page.textCharacters>textOffset+40000;
      const coverage={complete:complete&&page.frames===0&&!textTruncated,textTruncated,textOffset,nextTextOffset:textTruncated?textOffset+40000:null,startY,nextY:complete?null:covered,coveredHeight:covered,pageHeight:lastHeight,segments:captures.length,unreadFrames:page.frames,maxSegments:limit};
      content.unshift({type:'text',text:JSON.stringify({...page,coverage,captures})});
      return {content,details:{url:page.url,title:page.title,coverage,captures}};
    }finally{
      if(await this.evaluate('location.href').catch(()=>null)===origin.url)await this.evaluate(`scrollTo(${origin.x},${origin.y})`).catch(()=>{});
    }
  }
  cancel(){
    if(this.native&&this.surface==='preview'){this.generation++;this.native.cancelSurface?.(this.surface);return;}
    this.close();
  }
  close() {
    this.generation++;
    if(this.native){this.nativeReady=false;this.native.cancelSurface?.(this.surface);void this.native.request(this.surface,'close').catch(()=>{});}
    clearTimeout(this.idleTimer);
    this.previewServer?.close();this.previewServer=null;this.previewPath=null;this.previewRevision=null;
    for(const item of this.previewServers.values())item.server.close();this.previewServers.clear();
    for(const req of this.pending.values()) {clearTimeout(req.timer);req.reject(new Error("浏览器已关闭"));} this.pending.clear();
    const child=this.child, socket=this.socket, profile=this.profile;
    if(socket?.readyState===1) {
      try { socket.send(JSON.stringify({id:++this.sequence,method:"Browser.close"})); } catch {}
      const fallback=setTimeout(()=>child?.kill(),2000); fallback.unref(); child?.once("exit",()=>clearTimeout(fallback));
    } else child?.kill();
    // `this.child` is only the launcher; remove the profile after the real browser
    // had a chance to shut down through Browser.close.
    if(profile){ this.profile=null; const cleanup=setTimeout(()=>{void rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200}).catch(()=>{});},2500); cleanup.unref(); }
    this.socket=null; this.child=null; this.sessionId=null;
  }
}
