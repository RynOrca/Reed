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
      const handlers={};const emit=payload=>(handlers['agent-event']||[]).forEach(fn=>fn({payload}));
      const provider={id:'test',template:'custom',name:'隔离模型',baseUrl:'http://localhost/v1',protocol:'openai-completions',models:[{id:'test-model',name:'测试模型',contextWindow:65536,reasoning:false}]};
      window.SUMMON_SETTINGS_SECTION='vault';window.failSave=false;
      window.__TAURI__={event:{listen:async(name,fn)=>{(handlers[name]??=[]).push(fn);return ()=>{};}},core:{invoke:async(name,args)=>{
        if(name==='desktop_preferences')return {theme:'dark'};if(name==='app_version')return '0.2.1';if(name!=='agent_command')return;
        const c=args.command;queueMicrotask(()=>{
          if(c.type==='get_state'){emit({type:'providers',templates:[{id:'custom',name:'自定义',protocol:'openai-completions'}],providers:[provider]});emit({type:'capabilities',state:{vaultPath:'C:\\test-vault',skills:[]}});emit({type:'vault_overview',state:'ready',path:'C:\\test-vault\\Reed-笔记库总览.md',model:'test/test-model'});}
          if(c.type==='browse_notes'){const all=Array.from({length:12},(_,i)=>({title:`数学/笔记${i+1}.md`,content:'矩阵与线性变换的笔记摘要。',url:`summon-file:note-${i}`}));emit({type:'ack',id:c.id,results:all.slice(c.offset,c.offset+5),next:c.offset+5<12?c.offset+5:null,total:12});return;}
          if(c.type==='update_model'&&window.failSave){emit({type:'error',id:c.id,message:'隔离保存失败'});return;}
          emit({type:'ack',id:c.id,providerId:'test'});
        });
      }}};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/settings.html`);await page.waitForFunction(()=>document.querySelectorAll('#vault-browse .card').length===5);
    assert.match(await page.locator('#vault-overview-status').innerText(),/总览已保存.*test\/test-model/);
    await page.locator('#vault-browse-more').click();assert.equal(await page.locator('#vault-browse .card').count(),10);await page.locator('#vault-browse-more').click();assert.equal(await page.locator('#vault-browse .card').count(),12);assert.equal(await page.locator('#vault-browse-more').isVisible(),false);await page.screenshot({path:path.join(artifacts,'browse.png'),fullPage:true});
    await page.locator('button[data-section="models"]').click();await page.locator('#providers .configured').click();await page.locator('#discovered-models button').filter({hasText:'编辑',exact:true}).click();
    await page.evaluate(()=>window.failSave=true);await page.locator('#manual-save').click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('保存失败'));assert.equal(await page.locator('#provider-form').isVisible(),true);assert.equal(await page.locator('#manual-model').inputValue(),'test-model');
    await page.evaluate(()=>window.failSave=false);await page.locator('#manual-save').click();await page.waitForFunction(()=>document.querySelector('#provider-form').hidden);assert.match(await page.locator('#notice').innerText(),/test-model.*已保存/);assert.equal(await page.locator('#notice').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true);
    await page.screenshot({path:path.join(artifacts,'model-saved.png')});assert.deepEqual(errors,[]);console.log('PASS: 五篇追加、末页结束、恢复状态、失败保留输入、成功收起与可见反馈；页面错误 0');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
