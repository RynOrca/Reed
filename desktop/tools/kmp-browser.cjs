const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH||'playwright');
(async()=>{
  const preview=await require('./create-interactive-preview.cjs').createPreview();
  const {createKmpTrace}=await import('../web/kmp-trace.mjs');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000},hasTouch:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(preview).href);
    const card=page.locator('.interactive-card').filter({hasText:'KMP：前缀表与完整匹配'});await card.locator('.kmp-view').waitFor();
    assert.deepEqual(await card.locator('.kmp-pi').allTextContents(),['0','?','?','?','?']);
    const trace=createKmpTrace({text:'ABABABC',pattern:'ABABC'});
    await card.evaluate((el,trace)=>{
      const range=el.querySelector('.algorithm-progress');
      for(let step=0;step<trace.length;step++){
        range.value=step;range.dispatchEvent(new Event('input',{bubbles:true}));
        const actual=[...el.querySelectorAll('.kmp-pi')].map(x=>x.textContent),s=trace[step],expected=s.pi.map((v,i)=>i<s.known?String(v):'?');
        if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('pi mismatch '+step);
        if([...el.querySelectorAll('.algorithm-code li')].indexOf(el.querySelector('.algorithm-code [aria-current=step]'))+1!==s.line)throw new Error('code line mismatch '+step);
      }
      range.dispatchEvent(new Event('change',{bubbles:true}));
    },trace);
    assert.match(await card.locator('.kmp-result').innerText(),/索引：2/);assert.equal(await card.locator('.kmp-cell.found').count(),10);
    const apply=async(text,pattern)=>{await card.getByLabel('文本串',{exact:true}).fill(text);await card.getByLabel('模式串',{exact:true}).fill(pattern);await card.getByRole('button',{name:'重新生成过程'}).click();await card.getByRole('slider',{name:'执行步骤'}).focus();await page.keyboard.press('End');};
    await apply('AAAAAB','AAAB');assert.match(await card.locator('.kmp-result').innerText(),/索引：2/);
    await apply('AAAAA','B');assert.match(await card.locator('.kmp-result').innerText(),/索引：-1/);
    await apply('','');assert.match(await card.locator('.kmp-result').innerText(),/索引：0/);
    await apply('你好你好世界','你好世界');assert.match(await card.locator('.kmp-result').innerText(),/索引：2/);
    await apply('😀','A');assert.match(await card.getByRole('alert').innerText(),/emoji/);
    await apply('ABABABC','ABABC');const fallback=trace.findIndex(s=>s.line===15);
    await card.getByRole('slider',{name:'执行步骤'}).evaluate((el,step)=>{el.value=step;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},fallback);
    assert.match(await card.locator('.algorithm-explanation').innerText(),/i=4 不变/);
    const out=path.resolve(__dirname,'../../dist/acceptance');await fs.mkdir(out,{recursive:true});await card.screenshot({path:path.join(out,'kmp-full.png')});
    await page.setViewportSize({width:360,height:800});await apply('AB'.repeat(24),'AB'.repeat(12));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await card.getByRole('button',{name:'重置',exact:true}).tap();assert.equal(await card.getByRole('slider',{name:'执行步骤'}).inputValue(),'0');
    await card.getByRole('button',{name:'下一步',exact:true}).tap();assert.equal(await card.getByRole('slider',{name:'执行步骤'}).inputValue(),'1');
    assert.deepEqual(errors,[]);console.log('KMP browser passed: every pi/code step, complete result, fallback, custom/empty/Chinese inputs, emoji rejection, touch and 360px long strings.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
