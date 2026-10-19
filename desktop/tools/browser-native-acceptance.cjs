// Real WebView2 host, isolated profile and local synthetic model. No msedge.exe
// launch. Test failures terminate the owned process tree and are never retried.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createServer}=require('node:http');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH||'C:/Users/Orca/AppData/Local/Programs/Python/Python314/Lib/site-packages/playwright/driver/package');
const execute=promisify(execFile);
async function resizeOwnedWindow(pid,width,height,capture=''){
  // Exercise real OS resizing without granting web content window-write APIs.
  const script=`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ReedTestResize {
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 public struct Rect {public int Left,Top,Right,Bottom;}
}
'@
[ReedTestResize]::SetProcessDPIAware()|Out-Null
$taskWindow=(Get-Process -Id ${Number(pid)}).MainWindowHandle
if($taskWindow -eq 0){throw 'Owned test window not found'}
$taskScale=[ReedTestResize]::GetDpiForWindow($taskWindow)/96.0
if(${Number(width)} -gt 0 -and -not [ReedTestResize]::SetWindowPos($taskWindow,[IntPtr]::Zero,0,0,[int](${Number(width)}*$taskScale),[int](${Number(height)}*$taskScale),0x16)){throw 'Owned window resize failed'}
${capture?`Add-Type -AssemblyName System.Drawing
[ReedTestResize]::SetForegroundWindow($taskWindow)|Out-Null
Start-Sleep -Milliseconds 200
$taskRect=New-Object ReedTestResize+Rect
[ReedTestResize]::GetWindowRect($taskWindow,[ref]$taskRect)|Out-Null
$taskBitmap=New-Object Drawing.Bitmap ($taskRect.Right-$taskRect.Left),($taskRect.Bottom-$taskRect.Top)
$taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap)
try{
 if([ReedTestResize]::GetForegroundWindow() -eq $taskWindow){$taskGraphics.CopyFromScreen($taskRect.Left,$taskRect.Top,0,0,$taskBitmap.Size)}
 else{$taskDC=$taskGraphics.GetHdc();try{if(-not [ReedTestResize]::PrintWindow($taskWindow,$taskDC,2)){throw 'Owned window capture unavailable'}}finally{$taskGraphics.ReleaseHdc($taskDC)}}
 $taskBitmap.Save([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(capture).toString('base64')}')),[Drawing.Imaging.ImageFormat]::Png)
}finally{$taskGraphics.Dispose();$taskBitmap.Dispose()}`:''}
`;
  try{await execute('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});}
  catch(error){throw Error('原生测试窗口探测失败：'+(error.stderr||error.message).slice(-2000));}
}
(async()=>{
  const root=path.resolve(__dirname,'../..'),out=path.resolve(process.env.SUMMON_BROWSER_TEST_OUT||path.join(root,'dist/browser-native-acceptance'));await fs.mkdir(out,{recursive:true});
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'reed-browser-native-')),project=path.join(data,'test-project');await fs.mkdir(project);
  const executable=process.env.SUMMON_BROWSER_TEST_EXE||path.join(root,'desktop/src-tauri/target/debug/summon-desktop.exe');
  const checks=[],errors=[],requests=[],timings={};let child,browser,page;
  const fixture=path.join(project,'test-page.html');
  await fs.writeFile(path.join(project,'style.css'),'body{font:18px/1.8 system-ui;margin:30px;color:#1d3021;background:#f6f2e5}h1{color:#285e38}button{padding:12px}canvas{display:block;margin-top:20px}.long{height:1800px;background:linear-gradient(#92c69c,#fbecb7)}');
  await fs.writeFile(path.join(project,'widget.js'),"document.getElementById('counter').onclick=()=>{document.getElementById('value').textContent=String(Number(document.getElementById('value').textContent)+1)};const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#d44637';c.fillRect(0,0,360,120);c.fillStyle='#183cbb';c.fillRect(40,20,200,80);");
  await fs.writeFile(fixture,'<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Reed 原生浏览器合成验收</title><link rel="stylesheet" href="style.css"><script src="widget.js" defer></script></head><body><h1>独立网页预览</h1><p id="quote">矩阵乘法可以表示两个线性变换的复合。</p><button id="counter">增加计数</button><span id="value">0</span><canvas width="360" height="120"></canvas><p><a id="next" href="other.html">下一页</a></p><div class="long">向下阅读合成测试页面</div><p id="bottom">页面底部：原生读取成功</p></body></html>');
  await fs.writeFile(path.join(project,'other.html'),'<!doctype html><meta charset="utf-8"><title>第二页</title><h1>第二个本地HTML</h1>');
  const server=createServer(async(req,res)=>{
    if(req.url==='/external.html'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><title>合成外部网页</title><h1>HTTP导航验收</h1>');return;}
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'native-vision',context_length:65536,max_output_tokens:8192,supports_vision:true,reasoning:false}]}));return;}
    if(req.method!=='POST'){res.writeHead(404);res.end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    const texts=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:(m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'));
    const marker=texts.findLast(text=>/NATIVE_(READ|OPEN|AUDIT)_TEST/.test(text))||'',auditing=marker.includes('NATIVE_AUDIT_TEST'),reading=auditing||marker.includes('NATIVE_READ_TEST');
    const hasTool=id=>body.messages.some(m=>m.role==='tool'&&m.tool_call_id===id);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'native-test',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    const stage=auditing?(!hasTool('native-audit-preview')?['native-audit-preview',{action:'preview',path:fixture}]:!hasTool('native-audit-desktop')?['native-audit-desktop',{action:'screenshot',viewport:{width:1280,height:800}}]:!hasTool('native-audit-mobile')?['native-audit-mobile',{action:'screenshot',viewport:{width:390,height:844}}]:null):reading&&!hasTool('native-read')?['native-read',{action:'read_page',target:'preview',maxSegments:3}]:null;
    if(stage){send({role:'assistant',tool_calls:[{index:0,id:stage[0],type:'function',function:{name:'browser',arguments:JSON.stringify(stage[1])}}]},'tool_calls');}
    else{send({role:'assistant',content:reading?'已收到实际网页文字和图片。':`合成页面已准备好：[在内置浏览器打开 HTML](${fixture.replace(/\\/g,'/')})`});send({},'stop');}
    res.end('data: [DONE]\n\n');
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(data,'user-config.json'),JSON.stringify({version:1,memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:true}}));
  try{
    const port=process.env.SUMMON_BROWSER_TEST_PORT||'9342',started=Date.now();
    child=spawn(executable,[],{cwd:path.dirname(executable),windowsHide:true,env:{...process.env,SUMMON_TEST_DATA_DIR:data,SUMMON_TEST_WEBVIEW_PORT:port},stdio:'ignore'});
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Reed宿主提前退出 '+child.exitCode);try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:500});break;}catch{await new Promise(resolve=>setTimeout(resolve,150));}}
    assert.ok(browser,'WebView2 CDP未就绪');page=browser.contexts()[0].pages().find(p=>!p.url().includes('settings.html'));assert.ok(page);
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>document.getElementById('status')?.textContent==='就绪',{timeout:30000});timings.appReadyMs=Date.now()-started;
    const command=(type,args={})=>page.evaluate(({type,args})=>new Promise(async(resolve,reject)=>{
      const id='native-'+crypto.randomUUID(),timer=setTimeout(()=>{off?.();reject(Error('原生验收命令超时 '+type));},90000);
      let off;off=await window.__TAURI__.event.listen('agent-event',event=>{const result=event.payload;if(result.id!==id||!['ack','browser_result','done','error'].includes(result.type))return;clearTimeout(timer);off();result.type==='error'?reject(Error(result.message)):resolve(result);});
      await window.__TAURI__.core.invoke('agent_command',{command:{id,type,...args}});
    }),{type,args});
    const native=(surface,method,params={})=>page.evaluate(request=>window.__TAURI__.core.invoke('browser_host',{request}),{surface,method,params});
    const evaluate=async expression=>(await native('preview','Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
    for(let i=0;i<100;i++){if((await native('preview','visibility')).exists)break;await page.waitForTimeout(100);}
    assert.deepEqual(await native('preview','visibility'),{exists:true,visible:false});
    assert.equal((await native('preview','ensure')).reused,true);checks.push('未点击HTML即已后台预热，实例存在且原生窗口隐藏');
    assert.notEqual(await page.locator('#browser-button svg').innerHTML(),await page.locator('#goals-button svg').innerHTML());checks.push('浏览器图标与学习目标图标不同');
    await page.locator('#browser-button').click();await page.locator('[data-browser=empty]').waitFor({state:'visible'});
    assert.equal((await native('preview','visibility')).visible,false);
    await page.locator('[data-browser=close]').click();await page.locator('.browser-pane:not(.workspace-outgoing)').waitFor({state:'hidden'});await page.waitForFunction(()=>!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
    assert.equal((await native('preview','visibility')).visible,false);checks.push('首次点击空浏览器入口及关闭均不将原生网页浮在聊天上');
    await command('change_workspace',{path:project});
    const provider=await command('save_provider',{template:'custom',name:'内置浏览器隔离验收',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions'});
    await command('discover_models',{providerId:provider.providerId});
    await command('update_model',{providerId:provider.providerId,model:{id:'native-vision',enabled:true,vision:true,reasoning:false,contextWindow:65536,maxTokens:8192}});
    await command('select_model',{provider:provider.providerId,model:'native-vision'});
    await command('set_role_learning',{roleId:'agent',learningModeEnabled:true,canvasEnabled:true});
    await command('prompt',{text:'NATIVE_OPEN_TEST'});
    const link=page.locator('a[data-local-file]').filter({hasText:'在内置浏览器打开 HTML'});await link.waitFor();
    const opening=Date.now();await link.click();
    await page.waitForFunction(()=>document.querySelector('.browser-pane:not(.workspace-outgoing)')?.dataset.state==='ready'&&!document.querySelector('[data-browser=read]').disabled,{timeout:30000});timings.openPreviewMs=Date.now()-opening;
    assert.equal(await evaluate('document.title'),'Reed 原生浏览器合成验收');
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"),'rgb(246, 242, 229)');checks.push('聊天HTML链接在独立原生预览打开，CSS/JS资源加载');
    await evaluate("document.getElementById('counter').click();true");assert.equal(await evaluate("document.getElementById('value').textContent"),'1');checks.push('HTML交互真实执行');
    const rect=await page.locator('[data-browser=viewport]').boundingBox(),viewport=await evaluate('({width:innerWidth,height:innerHeight})');
    assert.ok(Math.abs(rect.width-viewport.width)<3&&Math.abs(rect.height-viewport.height)<3,'原生子窗口尺寸与前端面板不一致');checks.push('原生窗口嵌入尺寸与前端一致，主窗口命令仍可用');
    await evaluate("(()=>{const range=document.createRange();range.selectNodeContents(document.getElementById('quote'));getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true;})()");
    await evaluate("[...document.querySelectorAll('[role=toolbar] button')].find(b=>b.textContent==='解释').click();true");
    await page.waitForFunction(()=>document.getElementById('prompt').value.includes('请解释这段内容'));
    assert.ok((await page.locator('#prompt').inputValue()).includes('矩阵乘法'));checks.push('划词工具条引用来源与上下文，进入草稿但未自动发送');
    const denied=await evaluate("window.__TAURI_INTERNALS__?window.__TAURI_INTERNALS__.invoke('agent_command',{command:{type:'init'}}).then(()=>false,()=>true):true");assert.equal(denied,true);checks.push('网页不能调用Reed宿主命令');
    await native('preview','Runtime.evaluate',{expression:"scrollTo(0,0);true",returnByValue:true});
    const previewShot=await native('preview','Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const previewBuffer=Buffer.from(previewShot.data,'base64');assert.ok(previewBuffer.length>8000,'原生截图疑似空白');await fs.writeFile(path.join(out,'preview-real.png'),previewBuffer);
    checks.push('可见预览生成真实PNG截图');
    const readStarted=Date.now(),read=await command('browser_read',{includeImages:true,maxSegments:2});timings.readPageMs=Date.now()-readStarted;
    const parsed=JSON.parse(read.result.content.find(b=>b.type==='text').text);assert.ok(parsed.text.includes('页面底部'));assert.equal(read.result.content.filter(b=>b.type==='image').length,2);assert.equal(parsed.coverage.complete,false);assert.ok(parsed.coverage.nextY>0);checks.push('整页文字与分段真实图片，长页范围及续读位置明确');
    const continuedPage=await command('browser_read',{includeImages:true,maxSegments:12,startY:parsed.coverage.nextY});assert.equal(continuedPage.result.details.coverage.complete,true);checks.push('长页可从nextY续读到页面底部');
    for(const [index,image]of read.result.content.filter(block=>block.type==='image').entries()){const buffer=Buffer.from(image.data,'base64');assert.equal(read.result.details.captures[index].width,buffer.readUInt32BE(16));assert.equal(read.result.details.captures[index].height,buffer.readUInt32BE(20));}checks.push('高DPI真实PNG尺寸与图片元数据一致');
    const continued=await command('prompt',{text:'NATIVE_READ_TEST'});assert.ok(continued);
    const imageCount=requests.at(-1).messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image_url'&&b.image_url.url.startsWith('data:image/png;base64,')).length;
    assert.ok(imageCount>0,'图片未进入模型请求');checks.push('视觉模型实际收到网页图片，本地模拟服务验证');
    await evaluate("document.getElementById('next').click();true");
    await page.waitForTimeout(250);assert.ok((await command('browser_action',{action:'snapshot'})).result.content[0].text.includes('第二页'));
    await page.locator('[data-browser=back]').click();await page.waitForTimeout(250);assert.equal(await evaluate('document.title'),'Reed 原生浏览器合成验收');checks.push('本地页面跳转与后退导航');
    await page.locator('[data-browser=address]').fill(`127.0.0.1:${server.address().port}/external.html`);await page.locator('[data-browser=address]').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.browser-pane:not(.workspace-outgoing)')?.dataset.state==='ready'&&!document.querySelector('[data-browser=read]').disabled);
    assert.equal(await evaluate('document.title'),'合成外部网页');assert.ok((await page.locator('[data-browser=address]').inputValue()).startsWith('http://127.0.0.1:'));await page.locator('[data-browser=address]').press('Escape');await page.keyboard.press('Control+l');assert.equal(await page.locator('[data-browser=address]').evaluate(el=>el.selectionEnd-el.selectionStart), (await page.locator('[data-browser=address]').inputValue()).length);await page.locator('[data-browser=address]').press('Escape');checks.push('裸本地域名自动补HTTP并真实加载，Ctrl+L全选与Escape恢复');await page.locator('[data-browser=back]').click();await page.waitForTimeout(200);assert.equal(await evaluate('document.title'),'Reed 原生浏览器合成验收');
    await page.locator('[data-browser=forward]').click();await page.waitForTimeout(200);assert.equal(await evaluate('document.title'),'合成外部网页');checks.push('本地HTML与HTTP网页之间后退/前进，历史本地服务保持可用');
    await command('browser_preview',{path:fixture});
    const warmStart=Date.now();await command('browser_prewarm');timings.reusedEnsureMs=Date.now()-warmStart;checks.push('预热与已有实例复用');
    const forbidden=await command('browser_preview',{path:path.join(project,'widget.js')}).then(()=>false,()=>true);assert.equal(forbidden,true);checks.push('拒绝非HTML本地预览');
    const independent=await native('agent','ensure');assert.equal(independent.engine,'webview2');
    await native('agent','Page.navigate',{url:await evaluate('location.href')});
    for(let i=0;i<50;i++){const ready=await native('agent','Runtime.evaluate',{expression:"document.readyState!=='loading'&&!!document.getElementById('counter')",returnByValue:true});if(ready.result.value)break;await new Promise(resolve=>setTimeout(resolve,50));}
    for(const [name,width,height]of [['desktop',1280,800],['mobile',390,844]]){
      await native('agent','Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      const shot=await native('agent','Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:0,y:0,width,height,scale:1}}),buffer=Buffer.from(shot.data,'base64');
      assert.equal(buffer.readUInt32BE(16),width);assert.equal(buffer.readUInt32BE(20),height);assert.ok(buffer.length>5000);await fs.writeFile(path.join(out,'agent-'+name+'.png'),buffer);
    }
    await command('prompt',{text:'NATIVE_AUDIT_TEST'});assert.equal(await evaluate('document.title'),'Reed 原生浏览器合成验收');
    const auditImages=requests.at(-1).messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image_url').slice(-2);assert.equal(auditImages.length,2);
    for(const [index,expected]of [[0,[1280,800]],[1,[390,844]]]){const buffer=Buffer.from(auditImages[index].image_url.url.split(',')[1],'base64');assert.deepEqual([buffer.readUInt32BE(16),buffer.readUInt32BE(20)],expected);}
    const receipts=requests.at(-1).messages.filter(m=>m.role==='tool'&&['native-audit-desktop','native-audit-mobile'].includes(m.tool_call_id));assert.equal(receipts.length,2);assert.ok(receipts.every(m=>JSON.stringify(m.content).includes('sourceHash')));
    checks.push('独立验收页桌面/窄屏真实截图与来源收据，Agent工具图片进入模型请求，不改变用户页');
    await page.locator('[data-browser=read]').click();await page.waitForFunction(()=>document.querySelectorAll('#attachment-strip .attachment-chip').length>1);
    assert.ok((await page.locator('#prompt').inputValue()).includes('网页阅读.md'));checks.push('读取整页按钮将正文和真实图片加入草稿附件，不自动发送');
    while(await page.locator('#attachment-strip .attachment-chip button').count())await page.locator('#attachment-strip .attachment-chip button').first().click();
    await resizeOwnedWindow(child.pid,0,0,path.join(out,'window-browser-native.png'));
    await page.locator('[data-browser=close]').click();await page.locator('.browser-pane:not(.workspace-outgoing)').waitFor({state:'hidden'});await page.waitForFunction(()=>!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
    assert.equal((await native('preview','visibility')).visible,false);
    await page.locator('#prompt').click();assert.equal(await page.evaluate(()=>document.activeElement.id),'prompt');
    await resizeOwnedWindow(child.pid,0,0,path.join(out,'window-chat-closed-native.png'));checks.push('关闭后原生HWND确实隐藏，真实鼠标可点击聊天输入框');
    for(let i=0;i<3;i++){
      await page.locator('#browser-button').click();await page.waitForFunction(()=>document.querySelector('.browser-pane:not(.workspace-outgoing)').hidden===false&&!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
      await page.waitForFunction(()=>!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));await page.waitForTimeout(80);assert.equal((await native('preview','visibility')).visible,true);
      await page.locator('#canvas-button').click();await page.waitForFunction(()=>document.querySelector('.canvas-pane:not(.workspace-outgoing)').hidden===false&&!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
      assert.equal((await native('preview','visibility')).visible,false);assert.equal(await page.locator('.browser-pane:not(.workspace-outgoing)').isVisible(),false);
      if(i===0)await resizeOwnedWindow(child.pid,0,0,path.join(out,'window-canvas-native.png'));
      await page.locator('#browser-button').click();await page.waitForFunction(()=>document.querySelector('.browser-pane:not(.workspace-outgoing)').hidden===false&&!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
      assert.equal(await page.locator('.canvas-pane:not(.workspace-outgoing)').isVisible(),false);
      await page.locator('[data-browser=close]').click();await page.waitForFunction(()=>document.querySelector('.browser-pane:not(.workspace-outgoing)').hidden&&!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
      assert.equal((await native('preview','visibility')).visible,false);
    }
    checks.push('浏览器画布连续往返切换三轮互斥，关闭后无网页残留');
    await page.evaluate(()=>{for(let i=0;i<6;i++)document.getElementById('browser-button').click();});
    await page.waitForTimeout(800);assert.equal((await native('preview','visibility')).visible,false);assert.equal(await page.locator('.browser-pane:not(.workspace-outgoing)').isVisible(),false);checks.push('快速六次切换最终关闭，不接受过期显示请求');
    await page.locator('#browser-button').click();
    await page.waitForFunction(()=>!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));await page.waitForTimeout(80);assert.equal(await evaluate('document.getElementById("value").textContent'),'0');checks.push('关闭再展开保留已加载页面');
    await page.locator('[data-browser=close]').click();await page.waitForFunction(()=>document.querySelector('.browser-pane:not(.workspace-outgoing)').hidden&&!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
    const collapsedWidth=await page.evaluate(()=>innerWidth);
    const reversal=await page.evaluate(async()=>{
      const frames=[],start=performance.now();let sampling=true;
      const sample=()=>{frames.push({ms:performance.now()-start,width:innerWidth,chat:document.querySelector('.chat-shell').getBoundingClientRect().width,moving:document.querySelector('.reed-workspace').classList.contains('workspace-moving')});if(sampling)requestAnimationFrame(sample);};sample();
      const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      document.getElementById('browser-button').click();await pause(85);
      document.getElementById('browser-button').click();await pause(35);
      document.getElementById('canvas-button').click();await pause(45);
      document.getElementById('browser-button').click();await pause(40);
      document.getElementById('browser-button').click();await pause(1400);sampling=false;
      return frames;
    });
    await page.waitForFunction(()=>!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
    await fs.writeFile(path.join(out,'reversal.json'),JSON.stringify({collapsedWidth,frames:reversal,final:await page.evaluate(()=>({width:innerWidth,browser:document.querySelector('.browser-pane:not(.workspace-outgoing)').hidden,canvas:document.querySelector('.canvas-pane:not(.workspace-outgoing)').hidden}))},null,2));
    assert.ok(Math.abs(await page.evaluate(()=>innerWidth)-collapsedWidth)<3,'Reversal did not restore collapsed width: '+collapsedWidth+' -> '+await page.evaluate(()=>innerWidth));
    assert.equal(await page.locator('.browser-pane:not(.workspace-outgoing)').isVisible(),false);assert.equal(await page.locator('.canvas-pane:not(.workspace-outgoing)').isVisible(),false);assert.equal((await native('preview','visibility')).visible,false);
    assert.ok(new Set(reversal.map(frame=>frame.width)).size>2,'No intermediate window widths during reversal');
    assert.equal(await page.locator('.workspace-outgoing,.browser-motion-image').count(),0);
checks.push('动画中五次反向/跨面板点击仅落实最后关闭目标，原尺寸恢复且无残留');
    await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#browser-button').click();await page.waitForFunction(()=>!document.querySelector('.reed-workspace').classList.contains('workspace-moving'));
    assert.equal((await native('preview','visibility')).visible,true);await page.emulateMedia({reducedMotion:'no-preference'});checks.push('减少动态效果模式可直接切换且原生页面正常显示');
    if(process.env.SUMMON_TEST_TRANSITIONS==='1'){
      await page.evaluate(()=>{
        // Tauri's exported invoke is read-only. Observe actual IPC fetches,
        // recording only the geometry flag, never invoke keys or other payloads.
        window.__windowTransitions=[];const original=window.fetch;
        window.fetch=(input,options,...rest)=>{
          const url=typeof input==='string'?input:input.url;
          if(url.endsWith('/set_canvas_window'))window.__windowTransitions.push({expanded:JSON.parse(options.body).expanded,ms:performance.now()});
          return original(input,options,...rest);
        };
      });
      await page.evaluate(()=>window.__TAURI__.core.invoke('set_canvas_window',{expanded:true}));
      assert.ok(await page.evaluate(()=>window.__windowTransitions.length>0),'Geometry IPC observer is inactive');
      const summaries=[];
      async function recordTransition(name,selector,handoff=false){
        const directory=path.join(out,name);await fs.mkdir(directory,{recursive:true});
        const task=execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'desktop/tools/workspace-transition-probe.ps1'),'-OwnerPid',String(child.pid),'-Output',directory,'-Duration','2600'],{windowsHide:true,timeout:15000}).then(()=>({}),error=>({error}));
        for(let i=0;i<100;i++){if(await fs.access(path.join(directory,'ready')).then(()=>true,()=>false))break;await page.waitForTimeout(50);}
        assert.ok(await fs.access(path.join(directory,'ready')).then(()=>true,()=>false),'Native frame recorder did not start');
        await page.evaluate(()=>{
          window.__windowTransitions=[];window.__layoutFrames=[];window.__samplingLayout=true;
          const sample=()=>{const root=document.querySelector('.reed-workspace').getBoundingClientRect(),chat=document.querySelector('.chat-shell').getBoundingClientRect();window.__layoutFrames.push({ms:performance.now(),width:root.width,chat:chat.width,right:root.right-chat.right});if(window.__samplingLayout)requestAnimationFrame(sample);};sample();
        });await page.locator(selector).click();
        const completed=await task;if(completed.error)throw Error('Native frame recording failed: '+completed.error.stderr);
        const frames=JSON.parse(await fs.readFile(path.join(directory,'samples.json'),'utf8'));
        assert.ok(frames.length>=20,'Insufficient native transition samples');
        const gaps=frames.slice(1).map((frame,i)=>frame.ms-frames[i].ms),maxGap=Math.max(...gaps);
        assert.ok(maxGap<250,'Native sampling gap too large');
        assert.ok(frames.filter(frame=>frame.rightOwned).length>=20,'Insufficient owned chat-area samples');
        assert.equal(frames.filter(frame=>frame.rightOwned&&frame.rightWhite>.85).length,0,'White flash in owned native chat patch');
        const layout=await page.evaluate(()=>{window.__samplingLayout=false;return window.__layoutFrames;});
        await fs.writeFile(path.join(directory,'layout.json'),JSON.stringify(layout,null,2));
        assert.ok(layout.every(frame=>Math.abs(frame.right)<3),'Chat lost its right anchor during motion');
        if(handoff)assert.ok(new Set(layout.map(frame=>Math.round(frame.chat))).size>=3,'Split layout switched without intermediate widths');
        const calls=await page.evaluate(()=>window.__windowTransitions);
        assert.ok(calls.length>0,'Transition produced no observed geometry IPC');
        if(!handoff)assert.ok(new Set(frames.map(frame=>frame.width)).size>=3,'Window changed without intermediate native widths');
        if(handoff){assert.equal(new Set(frames.map(frame=>frame.width)).size,1,'Panel handoff resized native window');assert.ok(calls.every(call=>call.expanded===true),'Panel handoff collapsed before expansion');}
        summaries.push({name,frames:frames.length,ownedChatSamples:frames.filter(frame=>frame.rightOwned).length,maxGapMs:maxGap,widths:[...new Set(frames.map(frame=>frame.width))],calls,modes:[...new Set(frames.map(frame=>frame.mode))],whiteFlashSamples:0});
      }
      for(const theme of ['dark','light']){
        await page.evaluate(theme=>window.__TAURI__.core.invoke('set_appearance',{style:'glass',theme}),theme);
        await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await page.waitForTimeout(150);
        await recordTransition(theme+'-browser-canvas','#canvas-button',true);
        await recordTransition(theme+'-canvas-browser','#browser-button',true);
        await recordTransition(theme+'-browser-chat','[data-browser=close]');
        await recordTransition(theme+'-chat-canvas','#canvas-button');
        await recordTransition(theme+'-canvas-chat','[data-cv=close]');
        await recordTransition(theme+'-chat-browser','#browser-button');
      }
      await fs.writeFile(path.join(out,'transitions.json'),JSON.stringify(summaries,null,2));
      checks.push('深浅主题12组切换连续原生采样聊天区域无白屏，面板互切窗口宽度恒定且无收窄命令');
    }
    // CDP captures this renderer only; the native child view is captured
    // separately above. Do not label these as an OS composite screenshot.
    await page.screenshot({path:path.join(out,'shell-desktop.png')});
    const oldWidth=await evaluate('innerWidth');await page.locator('.browser-splitter').focus();await page.keyboard.press('ArrowLeft');await page.waitForTimeout(150);
    assert.ok(await evaluate('innerWidth')<oldWidth);checks.push('分隔线键盘调整同时更新原生页面尺寸');
    const original=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    await resizeOwnedWindow(child.pid,600,720);
    await page.waitForTimeout(200);assert.ok(Math.abs((await page.evaluate(()=>innerWidth))-600)<3,'Test host did not reach 600 CSS px');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const narrow=await page.locator('[data-browser=viewport]').boundingBox();assert.ok(Math.abs((await evaluate('innerWidth'))-narrow.width)<3);
    await command('browser_read',{includeImages:true,maxSegments:1});await command('browser_action',{action:'snapshot'});checks.push('窄于320px的实际预览仍可连续读页和截图');
    await page.screenshot({path:path.join(out,'shell-narrow.png')});checks.push('600px窄窗口布局无横向溢出，原生预览同步尺寸');
    await resizeOwnedWindow(child.pid,original.width,original.height);
    assert.deepEqual(errors,[]);checks.push('页面脚本错误0');
    await fs.writeFile(path.join(out,'result.json'),JSON.stringify({checks,timings,errors,data,requests:requests.length,imageCount},null,2));
    console.log(JSON.stringify({checks,timings,errors,imageCount},null,2));
  }catch(error){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,checks,timings,errors,data},null,2));throw error;}
  finally{
    if(browser)await browser.close().catch(()=>{});
    if(child?.pid)await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
