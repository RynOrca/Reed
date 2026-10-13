const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH||'playwright');
(async()=>{
  const preview=await require('./create-interactive-preview.cjs').createPreview(),browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000},hasTouch:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(preview).href);
    const gradient=page.locator('.interactive-card').filter({hasText:'自定义：梯度下降'}),queue=page.locator('.interactive-card').filter({hasText:'自定义：循环队列'}),policy=page.locator('.interactive-card').filter({hasText:'自定义：Softmax'});
    for(const card of [gradient,queue,policy])try{await card.locator('.custom-status').filter({hasText:'运行检查通过'}).waitFor({timeout:10000});}catch(e){console.log({errors,status:await page.locator('.custom-status').allTextContents(),frames:page.frames().map(f=>f.url())});throw e;}
    const g=gradient.frameLocator('iframe');await g.getByRole('button',{name:'迭代一步'}).click();await g.getByText('第 1 步；x=4.4000；f(x)=5.7600',{exact:true}).waitFor();
    await g.getByRole('slider',{name:'学习率 η'}).evaluate(el=>{el.value='.5';el.dispatchEvent(new Event('change',{bubbles:true}));});await g.getByRole('slider',{name:'学习率 η'}).filter({hasText:''}).waitFor();
    await g.getByRole('button',{name:'迭代一步'}).click();await g.getByText('第 2 步；x=2.0000；f(x)=0.0000',{exact:true}).waitFor();
    await gradient.getByRole('button',{name:'收起',exact:true}).click();await gradient.getByRole('button',{name:'展开',exact:true}).click();await g.getByText('第 2 步；x=2.0000；f(x)=0.0000',{exact:true}).waitFor();
    const q=queue.frameLocator('iframe');await q.getByRole('button',{name:'出队',exact:true}).click();await q.getByText('head=1，size=1，tail=(head+size)%4=2；就绪',{exact:true}).waitFor();await q.getByRole('button',{name:'入队',exact:true}).click();await q.getByText('head=1，size=2，tail=(head+size)%4=3；就绪',{exact:true}).waitFor();
    const p=policy.frameLocator('iframe');await p.getByRole('slider',{name:'动作0价值'}).evaluate(el=>{el.value='2';el.dispatchEvent(new Event('change',{bubbles:true}));});await p.getByText('动作0 0.500',{exact:true}).waitFor();
    const frame=page.mainFrame().childFrames()[0];
    assert.equal(await frame.evaluate(()=>{try{return !!parent.document.body&&false;}catch{return true;}}),true);
    assert.equal(await gradient.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    const out=path.resolve(__dirname,'../../dist/acceptance');await fs.mkdir(out,{recursive:true});for(const [name,card] of [['custom-gradient',gradient],['custom-queue',queue],['custom-policy',policy]])await card.screenshot({path:path.join(out,`${name}.png`)});
    await page.setViewportSize({width:360,height:800});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await gradient.getByRole('button',{name:'重置自定义作品'}).tap();await g.getByText('第 0 步；x=5.0000；f(x)=9.0000',{exact:true}).waitFor();await g.getByRole('button',{name:'迭代一步'}).tap();await g.getByText('第 1 步；x=4.4000；f(x)=5.7600',{exact:true}).waitFor();
    await g.getByRole('button',{name:'拖动探查点，方向键移动'}).press('ArrowLeft');try{await g.getByText('第 0 步；x=4.3500；f(x)=5.5225',{exact:true}).waitFor({timeout:5000});}catch(e){console.log(await g.locator('body').innerText());throw e;}
    assert.deepEqual(errors,[]);console.log('Custom SDK browser passed: slider/buttons, SVG, queue and policy facts, collapse/resume, reset, opaque frame, touch and 360px.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
