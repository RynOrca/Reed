const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createServer}=require('node:http');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH);
(async()=>{
  const root=path.resolve(__dirname,'../web'),artifacts=path.resolve(__dirname,'../../dist/vault-reliability');await fs.mkdir(artifacts,{recursive:true});
  const server=createServer(async(req,res)=>{try{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(root+path.sep))throw Error('outside');res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));}catch{res.statusCode=404;res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.SUMMON_EDGE_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});const page=await browser.newPage({viewport:{width:980,height:760}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
    await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    await page.addInitScript(()=>{
      const handlers={};const emit=payload=>(handlers['agent-event']||[]).forEach(fn=>fn({payload}));window.__emit=emit;
      const provider={id:'test',template:'custom',name:'隔离模型',baseUrl:'http://localhost/v1',protocol:'openai-completions',models:[{id:'test-model',name:'测试模型',contextWindow:65536,reasoning:false}]};
      let working=[{id:'work-a',kind:'workflow',title:'构建流程',body:'项目 A 构建',scope:'C:\\project-a',evidence:'Verified success',revision:2},{id:'work-b',kind:'workflow',title:'构建流程',body:'项目 B 构建',scope:'C:\\project-b'}];
      window.SUMMON_SETTINGS_SECTION='vault';window.failSave=false;
      window.__TAURI__={event:{listen:async(name,fn)=>{(handlers[name]??=[]).push(fn);return ()=>{};}},core:{invoke:async(name,args)=>{
        if(name==='desktop_preferences')return {theme:'dark'};if(name==='app_version')return '0.2.1';if(name!=='agent_command')return;
        const c=args.command;queueMicrotask(()=>{
          if(c.type==='get_state'){emit({type:'providers',templates:[{id:'custom',name:'自定义',protocol:'openai-completions'}],providers:[provider]});emit({type:'capabilities',state:{vaultPath:'C:\\test-vault',skills:[]}});emit({type:'vault_overview',state:'ready',path:'C:\\test-vault\\Reed-笔记库总览.md',model:'test/test-model'});emit({type:'memory',state:{enabled:{},working}});}
          if(c.type==='memory_work_delete'){working=working.filter(i=>i.id!==c.workId);emit({type:'memory',state:{enabled:{},working}});}
          if(c.type==='draft_work_skill'){emit({type:'ack',id:c.id,draft:{dir:'C:\\draft',body:'# 技能草稿\n\n适用条件、验证办法'}});return;}
          if(c.type==='browse_notes'){const all=Array.from({length:12},(_,i)=>({title:`数学/笔记${i+1}.md`,content:'矩阵与线性变换的笔记摘要。',url:`summon-file:note-${i}`}));emit({type:'ack',id:c.id,results:all.slice(c.offset,c.offset+5),next:c.offset+5<12?c.offset+5:null,total:12});return;}
          if(c.type==='save_provider'){provider.parallelRequests=c.parallelRequests;provider.maxConcurrentRequests=c.maxConcurrentRequests;window.lastProviderSave={parallelRequests:c.parallelRequests,maxConcurrentRequests:c.maxConcurrentRequests};emit({type:'providers',templates:[{id:'custom',name:'自定义',protocol:'openai-completions'}],providers:[provider]});}
          if(c.type==='update_model'&&window.failSave){emit({type:'error',id:c.id,message:'隔离保存失败'});return;}
          emit({type:'ack',id:c.id,providerId:'test'});
        });
      }}};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/settings.html`);await page.waitForFunction(()=>document.querySelectorAll('#vault-browse .card').length===5);
    assert.match(await page.locator('#vault-overview-status').innerText(),/总览已生成并保存.*test\/test-model/);
    await page.screenshot({path:path.join(artifacts,'first-five.png'),fullPage:true});
    // 总览进度条：生成中显示在卡片右下角并随事件推进，完成后隐藏，提示文案不得累积。
    await page.evaluate(()=>window.__emit({type:'vault_overview',state:'generating',done:3,batches:8,failed:0,concurrency:2,progress:0.42,phase:'first_body',message:'正在理解笔记第 4/8 批（已收到模型数据，单次生成最多等待 5 分钟）'}));
    await page.waitForFunction(()=>!document.getElementById('overview-progress').hidden);
    const bar=await page.evaluate(()=>{const node=document.getElementById('overview-progress'),card=node.closest('.card').getBoundingClientRect();
      return {fill:document.getElementById('overview-progress-fill').style.width,label:document.getElementById('overview-progress-label').textContent,value:node.getAttribute('aria-valuenow'),gapRight:Math.round(card.right-node.getBoundingClientRect().right)};});
    assert.equal(bar.fill,'42%');assert.match(bar.label,/42% · 3\/8 批/);assert.equal(bar.value,'42');assert.ok(bar.gapRight<30,`进度条必须靠卡片右侧（右侧间距 ${bar.gapRight}px）`);
    const statusText=await page.locator('#vault-overview-status').innerText();
    assert.ok(!/本次数据接收完成.*本次数据接收完成/s.test(statusText),'阶段提示不得累积');
    await page.screenshot({path:path.join(artifacts,'overview-progress.png'),fullPage:true});
    await page.evaluate(()=>window.__emit({type:'vault_overview',state:'ready',path:'C:\\test-vault\\Reed-笔记库总览.md',model:'test/test-model',concurrency:2,progress:1}));
    await page.waitForFunction(()=>document.getElementById('overview-progress').hidden&&document.getElementById('vault-overview-status').textContent.includes('并发 2'));
    await page.locator('#vault-browse-more').click();assert.equal(await page.locator('#vault-browse .card').count(),10);await page.locator('#vault-browse-more').click();assert.equal(await page.locator('#vault-browse .card').count(),12);assert.equal(await page.locator('#vault-browse-more').isVisible(),false);await page.screenshot({path:path.join(artifacts,'browse.png'),fullPage:true});
    await page.locator('button[data-section="models"]').click();await page.locator('#providers .configured').click();assert.equal(await page.locator('#parallel-requests').isChecked(),false);assert.equal(await page.locator('#parallel-limit').isDisabled(),true);
    assert.match(await page.locator('label').filter({has:page.locator('#parallel-requests')}).innerText(),/实验性/);
    await page.locator('#parallel-requests').check();await page.locator('#parallel-limit').fill('3');await page.locator('#parallel-requests').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifacts,'parallel-experimental.png')});
    await page.locator('#provider-form button[type="submit"]').click();await page.waitForFunction(()=>window.lastProviderSave?.parallelRequests===true&&window.lastProviderSave.maxConcurrentRequests===3);
    await page.locator('#cancel-provider').click();await page.locator('#providers .configured').click();assert.equal(await page.locator('#parallel-requests').isChecked(),true);assert.equal(await page.locator('#parallel-limit').inputValue(),'3');
    await page.locator('#parallel-requests').uncheck();assert.equal(await page.locator('#parallel-limit').isDisabled(),true);
    await page.locator('#discovered-models button').filter({hasText:'编辑',exact:true}).click();
    await page.evaluate(()=>window.failSave=true);await page.locator('#manual-save').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('保存失败'));assert.equal(await page.locator('#provider-form').isVisible(),true);assert.equal(await page.locator('#manual-model').inputValue(),'test-model');
    await page.evaluate(()=>window.failSave=false);await page.locator('#manual-save').click();await page.waitForFunction(()=>document.querySelector('#provider-form').hidden);assert.match(await page.locator('#notice').innerText(),/test-model.*已保存/);assert.equal(await page.locator('#notice').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
    await page.screenshot({path:path.join(artifacts,'model-saved.png')});
    await page.locator('button[data-section="memory"]').click();const row=page.locator('#working .memory-item').filter({hasText:'project-a'});
    await row.getByRole('button',{name:'生成技能草稿',exact:true}).click();await row.getByRole('button',{name:'导入技能库',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('角色中绑定'));
    await row.getByRole('button',{name:'删除',exact:true}).click();assert.equal(await page.locator('#working .memory-item').count(),2);await row.getByRole('button',{name:'确认删除',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#working .memory-item').length===1);assert.match(await page.locator('#working').innerText(),/project-b/);
    assert.deepEqual(errors,[]);console.log('PASS: 实验性并行默认关闭/开关/并发数保存重开，五篇追加、末页结束、恢复状态、失败保留输入、成功收起与可见反馈、同名经验两步精准删除；总览进度条靠右下角、阶段提示不累积；页面错误 0');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
