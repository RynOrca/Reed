// Fresh portable package acceptance: embedded native UI and packaged Agent, synthetic profile/provider.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createServer}=require('node:http');
const {createHash}=require('node:crypto');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  assert.ok(process.env.SUMMON_TEST_PACKAGE,'SUMMON_TEST_PACKAGE must identify a freshly built isolated package');
  const source=path.resolve(process.env.SUMMON_TEST_PACKAGE);
  const workspace=path.resolve(__dirname,'../..');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reed-usability-'));
  const pkg=path.join(root,'package'),data=path.join(root,'profile'),vault=path.join(root,'vault'),artifacts=path.join(workspace,'dist/desktop-usability');
  await Promise.all([fs.mkdir(pkg),fs.mkdir(data),fs.mkdir(vault),fs.mkdir(artifacts,{recursive:true})]);
  await fs.mkdir(path.join(pkg,'runtime'));
  await fs.copyFile(path.join(source,'Reed.exe'),path.join(pkg,'Reed.exe'));
  await fs.copyFile(path.join(source,'runtime/node.exe'),path.join(pkg,'runtime/node.exe'));
  await fs.symlink(path.join(source,'agent'),path.join(pkg,'agent'),'junction');
  for(let i=1;i<=12;i++)await fs.writeFile(path.join(vault,`笔记${String(i).padStart(2,'0')}.md`),`# 笔记${i}\n\n隔离数学笔记${i}。`);
  await fs.writeFile(path.join(root,'browser-test.html'),'<title>原生 browser 验收</title><h1>隔离 browser 工具</h1><button>测试按钮</button>');
  await fs.writeFile(path.join(vault,'Reed-笔记库总览.md'),'# 总览\n数学：12篇隔离笔记。');
  let calls=0,child,browser;const errors=[],checks=[];
  const report={basis:'fresh targeted portable build, embedded UI + packaged Agent; synthetic provider/profile, no installation',packagePath:source,nativeHostSha256:createHash('sha256').update(await fs.readFile(path.join(pkg,'Reed.exe'))).digest('hex'),checks,errors};
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'isolated-ui',supports_reasoning:false}]}));return;}
    const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks).toString());calls++;
    const text=JSON.stringify(input.messages.filter(m=>m.role==='user').at(-1));const slow=text.includes('CANCEL_UI_TEST');
    res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
    if(text.includes('BROWSER_UI_TEST')){
      const count=input.messages.filter(m=>m.role==='tool').length;
      if(count<2){const action=count===0?{action:'preview',path:path.join(root,'browser-test.html')}:{action:'screenshot',viewport:{width:390,height:844}};
        res.write(`data: ${JSON.stringify({id:'browser-ui',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'browser-'+count,type:'function',function:{name:'browser',arguments:JSON.stringify(action)}}]},finish_reason:null}]})}\n\n`);
        res.end(`data: ${JSON.stringify({id:'browser-ui',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);return;}
    }
    const timer=setTimeout(()=>{if(res.destroyed)return;res.write(`data: ${JSON.stringify({id:'ui',object:'chat.completion.chunk',model:'isolated-ui',choices:[{index:0,delta:{role:'assistant',content:'隔离桌面验证完成'},finish_reason:null}]})}\n\n`);res.end(`data: ${JSON.stringify({id:'ui',object:'chat.completion.chunk',model:'isolated-ui',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);},slow?12000:5000);
    res.on('close',()=>clearTimeout(timer));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const provider={id:'isolated',template:'custom',name:'隔离界面模型',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'isolated-ui',name:'隔离界面模型',contextWindow:65536,reasoning:false,input:['text','image']}]};
  await fs.writeFile(path.join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},capabilities:{vaultPath:vault,skills:[],webEnabled:false,browserEnabled:true},memoryEnabled:{l1:false,l2:false,l3:false,work:false},security:{approval:'ask',access:'workspace'}}));
  await fs.writeFile(path.join(data,'app-state.json'),JSON.stringify({provider:'isolated',modelId:'isolated-ui',projectPath:root}));
  // Reserve an unused CDP port without colliding with a user browser.
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  try{
    child=spawn(path.join(pkg,'Reed.exe'),[],{cwd:pkg,windowsHide:true,env:{...process.env,SUMMON_TEST_DATA_DIR:data,SUMMON_TEST_WEBVIEW_PORT:String(port)},stdio:'ignore'});
    for(let i=0;i<60;i++){if(child.exitCode!==null)throw Error(`native host exited ${child.exitCode}`);try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:500});break;}catch{await delay(400);}}
    assert.ok(browser,'isolated native CDP endpoint unavailable');const context=browser.contexts()[0];
    const main=context.pages().find(p=>!p.url().includes('settings.html'));assert.ok(main);await main.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:30000});const nativeUrl=new URL(main.url());report.nativeUrl=main.url();report.appVersion=await main.evaluate(()=>window.__TAURI__.core.invoke('app_version'));assert.equal(report.appVersion,'0.2.2');
    context.on('page',p=>p.on('pageerror',e=>errors.push(String(e))));main.on('pageerror',e=>errors.push(String(e)));
    await main.goto(nativeUrl.href+(nativeUrl.search?'&':'?')+'usability-source='+Date.now(),{waitUntil:'networkidle'});await main.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:30000});checks.push('新构建原生程序加载内嵌UI及包内Agent，临时profile隔离');
    await main.locator('#prompt').fill('只回复收到，不使用工具');await main.locator('#send-button').click();await main.locator('#stop-button').waitFor({state:'visible'});
    const emit=payload=>main.evaluate(p=>window.__TAURI__.event.emit('agent-event',p),payload);
    for(const [phase,expected] of [['local','正在查找本地笔记'],['expanding','最多等待 5 秒'],['fallback','本地检索结果'],['ready','已找到 2 段笔记']]){
      await emit({type:'knowledge_progress',phase,count:2});await main.locator('#status').filter({hasText:expected}).waitFor({timeout:3000});
      if(phase==='expanding')await main.screenshot({path:path.join(artifacts,'native-expanding.png')});
    }
    await main.locator('#stop-button').waitFor({state:'hidden',timeout:20000});await main.locator('.message-row.assistant').filter({hasText:'隔离桌面验证完成'}).waitFor();checks.push('实际mock回复完成，阶段状态事件回放可见，结束恢复就绪');
    const beforeCancel=calls;await main.locator('#prompt').fill('CANCEL_UI_TEST');await main.locator('#send-button').click();await main.locator('#stop-button').waitFor({state:'visible'});for(let i=0;i<100&&calls===beforeCancel;i++)await delay(100);assert.ok(calls>beforeCancel,'cancel test must reach provider first');await main.goto(nativeUrl.href+(nativeUrl.search?'&':'?')+'usability-busy='+Date.now(),{waitUntil:'networkidle'});await main.locator('#stop-button').waitFor({state:'visible',timeout:5000});await main.locator('.message-row.user').filter({hasText:'CANCEL_UI_TEST'}).waitFor();checks.push('忙碌时前端重载恢复历史及停止按钮，不误报就绪');await main.locator('#stop-button').click();await main.locator('#stop-button').waitFor({state:'hidden',timeout:10000});checks.push('请求实际到达provider后可取消，停止后控件恢复');
    const previousReplies=await main.locator('.message-row.assistant').count();await main.locator('#prompt').fill('再次只回复收到，不使用工具');await main.locator('#send-button').click();await main.waitForFunction(n=>document.querySelectorAll('.message-row.assistant').length>n,previousReplies,{timeout:20000});await main.locator('#stop-button').waitFor({state:'hidden',timeout:20000});checks.push('取消后能继续发送并完成下一条回复');
    await main.evaluate(async()=>{window.browserToolEvents=[];await window.__TAURI__.event.listen('agent-event',event=>{if(event.payload.type==='tool_end')window.browserToolEvents.push(event.payload);});});
    await main.locator('#prompt').fill('BROWSER_UI_TEST 预览并截图合成网页');await main.locator('#send-button').click();await main.locator('#stop-button').waitFor({state:'visible'});await main.locator('#stop-button').waitFor({state:'hidden',timeout:30000});
    const browserEvents=await main.evaluate(()=>window.browserToolEvents);assert.equal(browserEvents.length,2);assert.ok(browserEvents.every(e=>!e.isError));assert.ok(browserEvents.some(e=>e.result?.content?.some(c=>c.type==='image')));checks.push('新包内browser经真实Agent工具调用完成本地预览与窄屏PNG截图');
    await main.locator('#settings-button').click();let settings;
    for(let i=0;i<40;i++){settings=context.pages().find(p=>p.url().includes('settings.html'));if(settings)break;await delay(250);}assert.ok(settings);
    report.settingsUrl=settings.url();await settings.waitForFunction(expected=>document.querySelector('#vault-path')?.textContent.toLowerCase()===expected.toLowerCase(),vault);await settings.locator('button[data-section="vault"]').click();await settings.locator('#vault-browse .card').first().waitFor();assert.equal(await settings.locator('#vault-browse .card').count(),5);await settings.locator('#vault-overview-status').filter({hasText:'总览已保存'}).waitFor();checks.push('启动恢复已有总览，未重新生成');await settings.locator('#vault-overview-status').scrollIntoViewIfNeeded();await settings.screenshot({path:path.join(artifacts,'native-vault-entry.png')});await settings.locator('#vault-browse-more').scrollIntoViewIfNeeded();await settings.screenshot({path:path.join(artifacts,'native-first-five.png')});
    await settings.locator('#vault-browse-more').click();await settings.waitForFunction(()=>document.querySelectorAll('#vault-browse .card').length===10);await settings.locator('#vault-browse-more').click();await settings.waitForFunction(()=>document.querySelectorAll('#vault-browse .card').length===12);assert.equal(await settings.locator('#vault-browse-more').isVisible(),false);checks.push('真实Agent笔记浏览5→10→12且末页结束');
    await settings.locator('#vault-browse .card').last().scrollIntoViewIfNeeded();await settings.screenshot({path:path.join(artifacts,'native-browse.png')});await main.screenshot({path:path.join(artifacts,'native-complete.png')});
    await settings.locator('button[data-section="models"]').click();await settings.locator('#providers .configured').click();assert.equal(await settings.locator('#parallel-requests').isChecked(),false);assert.equal(await settings.locator('#parallel-limit').isDisabled(),true);assert.match(await settings.locator('label').filter({has:settings.locator('#parallel-requests')}).innerText(),/实验性/);checks.push('原生并行设置默认关闭、并发输入禁用且实验性标注可见');await settings.locator('#discovered-models button').filter({hasText:'编辑',exact:true}).click();await settings.locator('#manual-context').fill('32768');await settings.locator('#manual-save').click();await settings.waitForFunction(()=>document.querySelector('#provider-form').hidden&&document.querySelector('#notice').textContent.includes('已保存'));assert.equal(await settings.locator('#notice').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);const saved=JSON.parse(await fs.readFile(path.join(data,'user-config.json'),'utf8'));assert.equal(saved.providers.providers.find(p=>p.id==='isolated').models.find(m=>m.id==='isolated-ui').contextWindow,32768);checks.push('修改模型上下文长度实际落盘，保存后表单收起、成功反馈可见');await settings.screenshot({path:path.join(artifacts,'native-model-saved.png')});
    assert.deepEqual(errors,[]);report.status='passed';
  }catch(error){report.status='failed';report.failure=String(error.stack);if(browser)for(const [i,p] of browser.contexts().flatMap(c=>c.pages()).entries())await p.screenshot({path:path.join(artifacts,`failure-${i}.png`)}).catch(()=>{});process.exitCode=1;}
  finally{
    report.mockRequests=calls;await fs.writeFile(path.join(artifacts,'native-report.json'),JSON.stringify(report,null,2));
    await browser?.close().catch(()=>{});if(child?.pid&&child.exitCode===null)await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
    server.closeAllConnections();await new Promise(r=>server.close(r));
    assert.ok(root.startsWith(path.join(os.tmpdir(),'reed-usability-')),'cleanup must stay in owned temporary profile');await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
    console.log(JSON.stringify(report,null,2));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
