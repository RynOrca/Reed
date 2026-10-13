// Focused acceptance: only the new custom SDK / review path, isolated data.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{createServer}=require('node:http');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH);
(async()=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'reed-custom-desktop-')),pkg=await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE,data);
  const {createCustomExample}=await import('../agent/interactive-ui/custom-examples.mjs'),reviews=[],errors=[];
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString());res.setHeader('content-type','text/event-stream');
    const delta=(value,finish_reason=null)=>({id:'focused',object:'chat.completion.chunk',model:body.model,created:1,choices:[{index:0,delta:value,finish_reason}]});
    const write=(value,reason)=>res.write(`data: ${JSON.stringify(delta(value,reason))}\n\n`);
    if(body.model==='review-model'){reviews.push(body);write({role:'assistant',content:JSON.stringify({verdict:'pass',summary:'隔离审核结果：更新规则一致',issues:[]})});write({},'stop');}
    else if(!body.messages.slice(body.messages.findLastIndex(m=>m.role==='user')+1).some(m=>m.role==='tool')){write({role:'assistant',tool_calls:[{index:0,id:'custom-focused',type:'function',function:{name:'generate_learning_ui',arguments:JSON.stringify({document:JSON.stringify(createCustomExample())})}}]});write({},'tool_calls');}
    else{write({role:'assistant',content:'自定义作品已创建，请操作卡片。'});write({},'stop');}
    res.end('data: [DONE]\n\n');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=9313,child=spawn(path.join(pkg,'Reed.exe'),[],{cwd:pkg,windowsHide:true,env:{...process.env,SUMMON_TEST_DATA_DIR:data,SUMMON_TEST_WEBVIEW_PORT:String(port)},stdio:'ignore'});let browser;
  try{
    for(let i=0;i<50;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});break;}catch{await new Promise(r=>setTimeout(r,300));}}assert.ok(browser);
    const main=browser.contexts()[0].pages().find(p=>!p.url().includes('settings.html'));main.on('pageerror',e=>errors.push(e.message));await main.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:25000});
    await main.evaluate(async()=>{window._customEvents=[];await window.__TAURI__.event.listen('agent-event',e=>window._customEvents.push(e.payload));});
    const command=(type,args={})=>main.evaluate(({type,args})=>new Promise(async(resolve,reject)=>{const id='custom-'+crypto.randomUUID(),timer=setTimeout(()=>{off?.();reject(Error('命令超时'));},20000);let off;off=await window.__TAURI__.event.listen('agent-event',e=>{if(e.payload.id===id){clearTimeout(timer);off();e.payload.type==='error'?reject(Error(e.payload.message)):resolve(e.payload);}});await window.__TAURI__.core.invoke('agent_command',{command:{id,type,...args}});}),{type,args});
    const configure=async(name,id)=>{const p=(await command('save_provider',{template:'custom',name,protocol:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`})).providerId;await command('update_model',{providerId:p,model:{id,contextWindow:65536,reasoning:true,thinkingFormat:'openai',thinkingLevels:['off','low']}});return p;};
    const gen=await configure('生成测试','generator-model'),review=await configure('审核测试','review-model');
    await command('save_role',{roleId:'agent',name:'Agent',system:'用中文完成请求。',skills:[],interactiveUiEnabled:true,learningGoalsEnabled:false,learnerProfileEnabled:false});await command('select_model',{provider:gen,model:'generator-model',thinkingLevel:'off'});
    await main.locator('#settings-button').click();let settings;for(let i=0;i<40;i++){settings=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('settings.html'));if(settings)break;await new Promise(r=>setTimeout(r,100));}assert.ok(settings);settings.on('pageerror',e=>errors.push(e.message));await settings.locator('button[data-section=models]').click();
    await settings.locator('#shortcut').filter({hasText:/\+/}).waitFor({state:'attached'});await settings.locator('button[data-section=models]').click();await settings.locator('#models').waitFor({state:'visible'});
    assert.equal(await settings.locator('#interactive-review-enabled').isChecked(),false);await settings.locator('#interactive-review-enabled').check();await settings.locator('#interactive-review-model').selectOption(JSON.stringify([review,'review-model']));await settings.locator('#interactive-review-thinking').selectOption('low');await settings.locator('#interactive-review-form button[type=submit]').click();await settings.locator('#notice').filter({hasText:'独立审核设置已保存'}).waitFor();
    await command('new_session',{noProject:true});await main.locator('#prompt').fill('生成一个梯度下降交互式组件');await main.locator('#send-button').click();
    const card=main.locator('.interactive-card').filter({hasText:'自定义：梯度下降'});await card.getByRole('button',{name:'展开',exact:true}).click({timeout:30000});await card.locator('.custom-status').filter({hasText:'运行检查通过'}).waitFor();await main.waitForFunction(()=>document.getElementById('status').textContent==='就绪');
    const frame=card.frameLocator('iframe');await frame.getByRole('button',{name:'迭代一步'}).click();await frame.getByText('第 1 步；x=4.4000；f(x)=5.7600',{exact:true}).waitFor();
    const snapshot=await main.evaluate(()=>({sessionId:window._customEvents.filter(e=>e.type==='session').at(-1).sessionId,artifactId:window._customEvents.filter(e=>e.type==='interactive_artifact').at(-1).summary.artifactId}));
    let artifact;for(let i=0;i<20;i++){artifact=(await command('get_interactive_artifact',{artifactId:snapshot.artifactId})).artifact;if(artifact.state.x===4.4)break;await new Promise(r=>setTimeout(r,50));}
    assert.equal(artifact.state.x,4.4);assert.equal(artifact.quality.review.modelId,'review-model');assert.equal(artifact.quality.facts,'unverified');assert.equal(reviews.length,1);assert.equal(reviews[0].reasoning_effort,'low');assert.ok((await main.locator('#status-model').innerText()).includes('generator-model'));
    const childFrame=await card.locator('iframe').elementHandle().then(h=>h.contentFrame());assert.equal(await childFrame.evaluate(()=>{try{void parent.document.body;return false;}catch{return true;}}),true);
    await command('new_session',{noProject:true});await command('open_session',{sessionId:snapshot.sessionId});await card.getByRole('button',{name:'展开',exact:true}).click();await frame.getByText('第 1 步；x=4.4000；f(x)=5.7600',{exact:true}).waitFor();
    const out=path.resolve(__dirname,'../../dist/acceptance');await fs.mkdir(out,{recursive:true});await main.screenshot({path:path.join(out,'custom-ui-desktop.png')});await settings.screenshot({path:path.join(out,'independent-review-settings.png')});assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:['自定义生成/真实试运行','另一提供商审核+low档位','无手填输出上限','真实WebView2隔离与控件','历史恢复'],errors,data}));
  }catch(e){if(browser)for(const page of browser.contexts().flatMap(c=>c.pages()))console.error(page.url(),await page.locator('body').innerText().catch(()=>''));throw e;}
  finally{await browser?.close();child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
