// Real WebView2 host, isolated profile and local synthetic model. No msedge.exe
// launch. Test failures terminate the owned process tree and are never retried.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createServer}=require('node:http');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH||'C:/Users/Orca/AppData/Local/Programs/Python/Python314/Lib/site-packages/playwright/driver/package');
const execute=promisify(execFile);
(async()=>{
  const root=path.resolve(__dirname,'../..'),out=path.join(root,'dist/browser-native-acceptance');await fs.mkdir(out,{recursive:true});
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
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    const texts=body.messages.filter(m=>m.role==='user').map(m=>typeof m.content==='string'?m.content:(m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n'));
    const marker=texts.findLast(text=>/NATIVE_(READ|OPEN|AUDIT)_TEST/.test(text))||'',auditing=marker.includes('NATIVE_AUDIT_TEST'),reading=auditing||marker.includes('NATIVE_READ_TEST'),callId=auditing?'native-audit':'native-read';
    const toolResult=body.messages.some(m=>m.role==='tool'&&m.tool_call_id===callId);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'native-test',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    if(reading&&!toolResult){send({role:'assistant',tool_calls:[{index:0,id:callId,type:'function',function:{name:'browser',arguments:JSON.stringify({action:'read_page',target:auditing?'agent':'preview',maxSegments:3})}}]},'tool_calls');}
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
    await command('change_workspace',{path:project});
    const provider=await command('save_provider',{template:'custom',name:'内置浏览器隔离验收',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions'});
    await command('discover_models',{providerId:provider.providerId});
    await command('update_model',{providerId:provider.providerId,model:{id:'native-vision',enabled:true,vision:true,reasoning:false,contextWindow:65536,maxTokens:8192}});
    await command('select_model',{provider:provider.providerId,model:'native-vision'});
    await command('prompt',{text:'NATIVE_OPEN_TEST'});
    const link=page.locator('a[data-local-file]').filter({hasText:'在内置浏览器打开 HTML'});await link.waitFor();
    const opening=Date.now();await link.click();
    await page.waitForFunction(()=>document.querySelector('.browser-pane')?.dataset.state==='ready'&&!document.querySelector('[data-browser=read]').disabled,{timeout:30000});timings.openPreviewMs=Date.now()-opening;
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
    await page.locator('[data-browser=address]').fill(`http://127.0.0.1:${server.address().port}/external.html`);await page.locator('[data-browser=address]').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.browser-pane')?.dataset.state==='ready'&&!document.querySelector('[data-browser=read]').disabled);
    assert.equal(await evaluate('document.title'),'合成外部网页');await page.locator('[data-browser=back]').click();await page.waitForTimeout(200);assert.equal(await evaluate('document.title'),'Reed 原生浏览器合成验收');
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
    await command('prompt',{text:'NATIVE_AUDIT_TEST'});assert.equal(await evaluate('document.title'),'Reed 原生浏览器合成验收');checks.push('独立验收页桌面/窄屏真实截图，Agent工具图片进入模型请求，不改变用户页');
    await page.locator('[data-browser=read]').click();await page.waitForFunction(()=>document.querySelectorAll('#attachment-strip .attachment-chip').length>1);
    assert.ok((await page.locator('#prompt').inputValue()).includes('网页阅读.md'));checks.push('读取整页按钮将正文和真实图片加入草稿附件，不自动发送');
    while(await page.locator('#attachment-strip .attachment-chip button').count())await page.locator('#attachment-strip .attachment-chip button').first().click();
    await page.locator('[data-browser=close]').click();await page.locator('.browser-pane').waitFor({state:'hidden'});await page.locator('#browser-button').click();
    await page.waitForTimeout(150);assert.equal(await evaluate('document.getElementById("value").textContent'),'0');checks.push('关闭再展开保留已加载页面');
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
