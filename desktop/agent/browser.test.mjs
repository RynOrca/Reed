import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,rm,writeFile,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBrowser,captureOptions } from "./browser.mjs";
import { FileScope } from "./sandbox.mjs";
test("Screenshot limits reject excessive dimensions and animation waits before browser launch",()=>{
  assert.throws(()=>captureOptions({viewport:{width:9000,height:800}}),/视口/);
  assert.throws(()=>captureOptions({waitMs:10001}),/等待/);
  assert.throws(()=>captureOptions({waitMs:-1}),/等待/);
  assert.deepEqual(captureOptions({viewport:{width:390,height:844},waitMs:500}),{viewport:{width:390,height:844},waitMs:500,fullPage:false});
});
test("Local preview authorizes each resource and blocks directory escape",async()=>{
  const root=await mkdtemp(join(tmpdir(),"reed-preview-test-"));
  await writeFile(join(root,"index.html"),"<h1>preview</h1>");await writeFile(join(root,"style.css"),"h1{color:red}");
  const checks=[],scope={async check(path,mutation){checks.push({path,mutation});return path;}};
  const browser=new AgentBrowser(root,{scope});
  try {
    const url=await browser.preview(join(root,"index.html"));
    assert.equal(await (await fetch(url)).text(),"<h1>preview</h1>");assert.equal(browser.localPath(url),join(root,'index.html'));assert.equal(browser.localPath('https://example.org/page'),null);
    assert.equal((await fetch(new URL("style.css",url))).status,200);
    const u=new URL(url);u.pathname=u.pathname.replace("index.html","%2e%2e%2fsecret.txt");
    assert.equal((await fetch(u)).status,404);
    assert.ok(checks.length>=3 && checks.every(c=>c.mutation===false));
    await assert.rejects(browser.run({action:"navigate",url:"file:///C:/secret.txt"}),/HTTP/);
    assert.equal(browser.child,undefined);
  }finally {browser.close();await rm(root,{recursive:true,force:true});}
});
test("Owned lazy Edge can read, fill, click and screenshot an isolated page",{timeout:30000,skip:process.env.SUMMON_TEST_EXTERNAL_EDGE!=='1'},async()=>{
  const root=await mkdtemp(join(tmpdir(),"summon-browser-test-"));
  const server=createServer((_req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end('<title>Summon isolated browser</title><h1>Browser test</h1><input aria-label="Test input"><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button>');});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));const browser=new AgentBrowser(root);
  try{
    assert.equal(browser.child,undefined);
    const first=JSON.parse((await browser.run({action:"navigate",url:`http://127.0.0.1:${server.address().port}`})).content[0].text);assert.equal(first.title,"Summon isolated browser");assert.ok(first.text.includes("Browser test"));
    const input=first.controls.find(c=>c.tag==="INPUT"),button=first.controls.find(c=>c.tag==="BUTTON");assert.ok(input && button);
    await browser.run({action:"fill",index:input.index,text:"Verified local browser"});const result=await browser.run({action:"click",index:button.index});assert.ok(result.content[0].text.includes("Verified local browser"));
    const screenshot=await browser.run({action:"screenshot",viewport:{width:390,height:844},waitMs:100});assert.equal(screenshot.content[0].mimeType,"image/png");assert.ok(screenshot.content[0].data.length>100);assert.equal(screenshot.details.width,390);assert.equal(screenshot.details.height,844);assert.deepEqual(await readFile(screenshot.details.artifactPath),Buffer.from(screenshot.content[0].data,"base64"));
    await writeFile(join(root,"index.html"),'<title>Local animated artifact</title><style>body{height:1200px}h1{animation:pulse .2s infinite alternate}@keyframes pulse{to{opacity:.2}}</style><h1>Local preview</h1>');
    browser.scope=new FileScope({workspace:()=>root,readOnly:()=>[]});
    const local=await browser.run({action:"preview",path:"index.html",viewport:{width:1280,height:800}});assert.ok(local.content[0].text.includes("Local preview"));
    const later=await browser.run({action:"screenshot",waitMs:250,fullPage:true});assert.ok(later.details.height>=1200);assert.equal(later.details.sourcePath,join(root,"index.html"));assert.notEqual(later.details.artifactPath,screenshot.details.artifactPath);
    assert.equal(later.details.sourceChanged,false);assert.ok(later.details.revision.sha256);
    await writeFile(join(root,"index.html"),'<h1>Updated but not reloaded</h1>');
    const stale=await browser.run({action:"screenshot"});assert.equal(stale.details.sourceChanged,true);assert.equal(stale.details.revision.sha256,later.details.revision.sha256);
    assert.equal(stale.details.sourceHash,later.details.sourceHash);
    await browser.run({action:"preview",path:"index.html"});
    const fresh=await browser.run({action:"screenshot"});assert.equal(fresh.details.sourceChanged,false);assert.notEqual(fresh.details.sourceHash,stale.details.sourceHash);
    await writeFile(join(root,"index.html"),'<h1>Source artifact</h1><a href="other.html">跳转其他页面</a>');
    await writeFile(join(root,"other.html"),'<h1>Different artifact</h1>');
    const linked=await browser.run({action:"preview",path:"index.html"});
    const link=JSON.parse(linked.content[0].text).controls.find(c=>c.tag==="A");
    await browser.run({action:"click",index:link.index});
    const navigated=await browser.run({action:"screenshot",waitMs:200});
    assert.ok(navigated.details.url.endsWith("other.html"));
    assert.equal(navigated.details.sourcePath,null,"导航到另一页面不能作为原HTML的证据");
    assert.equal(navigated.details.sourceHash,null);
  }finally{browser.close();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,600));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});


test("owned browser reopens after idle-style shutdown without consuming stale debug port",{timeout:30000,skip:process.env.SUMMON_TEST_EXTERNAL_EDGE!=='1'},async()=>{
 const root=await mkdtemp(join(tmpdir(),"reed-browser-reopen-")),browser=new AgentBrowser(root);
 try{
  await browser.run({action:"snapshot"});const socket=browser.socket;
  // The msedge launcher exits right after spawning the real browser, so the CDP
  // socket closing is the shutdown signal here, not the launcher process.
  const closed=new Promise(resolve=>{if(!socket)resolve();else socket.addEventListener("close",resolve,{once:true});});
  browser.close();await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,3000))]);
  const reopened=await browser.run({action:"snapshot"});assert.ok(reopened.content[0].text.includes("about:blank"));
 }finally{const child=browser.child;const exited=child&&child.exitCode===null?new Promise(resolve=>child.once("exit",resolve)):Promise.resolve();browser.close();await exited;await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});


test("cancelled queued browser operation never runs",async()=>{
 const browser=new AgentBrowser("unused-synthetic");let release;browser.operations=new Promise(resolve=>release=resolve);let calls=0;browser.runOne=async()=>{calls++;};
 const controller=new AbortController();const queued=browser.run({action:"snapshot"},{signal:controller.signal});controller.abort();const rejected=assert.rejects(queued,/取消/);release();await rejected;assert.equal(calls,0);
});


test("active screenshot delay cancels promptly and owned browser can recover",{timeout:15000,skip:process.env.SUMMON_TEST_EXTERNAL_EDGE!=='1'},async()=>{
 const root=await mkdtemp(join(tmpdir(),"reed-browser-cancel-")),browser=new AgentBrowser(root);
 try{
  await browser.run({action:"snapshot"});const controller=new AbortController();const begin=Date.now();const operation=browser.run({action:"screenshot",waitMs:10000},{signal:controller.signal});
  const timer=setTimeout(()=>controller.abort(),100);try{await assert.rejects(operation,/取消/);}finally{clearTimeout(timer);}
  assert.ok(Date.now()-begin<1500,"cancel should not wait for the ten-second capture delay");
  assert.ok((await browser.run({action:"snapshot"})).content[0].text.includes("about:blank"));
 }finally{const child=browser.child;const exited=child&&child.exitCode===null?new Promise(resolve=>child.once("exit",resolve)):Promise.resolve();browser.close();await exited;await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});

test('preview keeps one server per file so a slow turn can reuse the URL',async()=>{
 const root=await mkdtemp(join(tmpdir(),"reed-preview-reuse-"));
 try{
  await writeFile(join(root,"index.html"),"<h1>one</h1>");
  await writeFile(join(root,"other.html"),"<h1>two</h1>");
  const scope={async check(path){return path;}};
  const browser=new AgentBrowser(root,{scope});
  const first=await browser.preview(join(root,"index.html"));
  const again=await browser.preview(join(root,"index.html"));
  assert.equal(again,first,'同一文件重复 preview 必须复用同一个地址');
  assert.equal(await (await fetch(again+"?cam=1")).text(),"<h1>one</h1>");
  const other=await browser.preview(join(root,"other.html"));
  assert.notEqual(other,first);
  assert.equal(await (await fetch(first)).text(),'<h1>one</h1>','打开其他本地HTML后历史地址仍可返回');
  browser.close();
 }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
});


test('本地大HTML完整流式读取，错误正文使用UTF8',async()=>{
 const root=await mkdtemp(join(tmpdir(),'reed-test-large-html-'));const file=join(root,'教材.html');
 const body='<meta charset="utf-8"><h1>中文教材</h1><!--'+'x'.repeat(17*1024*1024)+'-->';
 await writeFile(file,body);const browser=new AgentBrowser(root,{scope:{check:async p=>p}});
 try{const url=await browser.preview(file);const response=await fetch(url);assert.equal(response.status,200);assert.equal(await response.text(),body);
 const missing=await fetch(new URL('missing.css',url));assert.match(missing.headers.get('content-type'),/charset=utf-8/);assert.match(await missing.text(),/资源不可读取/);
 }finally{browser.close();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
