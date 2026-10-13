const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH||'playwright');
(async()=>{
  const preview=await require('./create-interactive-preview.cjs').createPreview();
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:1000},hasTouch:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(preview).href);
    const heap=page.locator('.interactive-card').filter({hasText:'堆排序：数组与二叉树'});await heap.locator('.learning-tree').waitFor();
    assert.deepEqual(await heap.locator('.tree-value').allTextContents(),['4','10','3','5','1']);
    await heap.evaluate(card=>{
      const range=card.querySelector('.algorithm-progress');
      for(let i=0;i<=Number(range.max);i++){
        range.value=i;range.dispatchEvent(new Event('input',{bubbles:true}));
        const array=[...card.querySelectorAll('.algorithm-value')].map(el=>el.textContent),tree=[...card.querySelectorAll('.tree-value')].map(el=>el.textContent);
        if(JSON.stringify(array.slice(0,tree.length))!==JSON.stringify(tree))throw new Error(`tree-array mismatch at ${i}`);
      }
      range.dispatchEvent(new Event('change',{bubbles:true}));
    });
    assert.deepEqual(await heap.locator('.algorithm-value').allTextContents(),['1','3','4','5','10']);assert.equal(await heap.locator('.tree-value').count(),0);
    await heap.getByLabel('输入数组').fill('3,-1,3,0');await heap.getByRole('button',{name:'重新生成过程'}).click();assert.equal(await heap.locator('.tree-value').count(),4);
    await heap.getByRole('slider',{name:'执行步骤'}).focus();await page.keyboard.press('End');assert.deepEqual(await heap.locator('.algorithm-value').allTextContents(),['-1','0','3','3']);
    const quadratic=page.locator('.interactive-card').filter({hasText:'二次函数：参数怎样'}),linear=page.locator('.interactive-card').filter({hasText:'线性代数：矩阵怎样'});
    const changeRange=async(card,name,value)=>card.getByRole('slider',{name,exact:true}).evaluate((el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
    const before=await quadratic.locator('.function-curve').getAttribute('points');
    await changeRange(quadratic,'水平平移 h',2);await changeRange(quadratic,'竖直平移 k',1);await changeRange(quadratic,'探查位置 x',3);
    assert.notEqual(await quadratic.locator('.function-curve').getAttribute('points'),before);assert.match(await quadratic.locator('.math-details').innerText(),/P = \(3, 2\)/);assert.match(await quadratic.locator('.math-details').innerText(),/斜率.*= 2/);
    await quadratic.locator('svg').scrollIntoViewIfNeeded();const box=await quadratic.locator('svg').boundingBox();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5);await page.mouse.up();
    assert.equal(await quadratic.getByRole('slider',{name:'探查位置 x',exact:true}).inputValue(),'2.5');
    await changeRange(quadratic,'开口系数 a',0);assert.equal(await quadratic.locator('.function-vertex').count(),0);assert.ok((await quadratic.locator('.math-details').innerText()).includes('没有唯一顶点'));
    await quadratic.getByRole('button',{name:'恢复初始参数'}).click();assert.equal(await quadratic.getByRole('slider',{name:'开口系数 a'}).inputValue(),'1');
    assert.match(await linear.locator('.math-details').innerText(),/det A = 1/);
    for(const [name,value] of [['矩阵 a（第1行第1列）','-1'],['矩阵 b（第1行第2列）','0'],['矩阵 c（第2行第1列）','0'],['矩阵 d（第2行第2列）','-1']]){await linear.getByLabel(name,{exact:true}).fill(value);await linear.getByLabel(name,{exact:true}).press('Tab');}
    await changeRange(linear,'变换进度 t',.5);assert.match(await linear.locator('.math-details').innerText(),/当前 det B\(t\) = 0/);assert.match(await linear.locator('.math-details').innerText(),/当前 B\(t\)v = \(0, 0\)/);
    await linear.getByRole('button',{name:'恢复初始参数'}).click();assert.match(await linear.locator('.math-details').innerText(),/目标 Av = \(2, 1\)/);
    await heap.getByLabel('输入数组').fill('4,10,3,5,1');await heap.getByRole('button',{name:'重新生成过程'}).click();
    const out=path.resolve(__dirname,'../../dist/acceptance');await fs.mkdir(out,{recursive:true});
    for(const [name,card] of [['heapsort-tree',heap],['quadratic-function',quadratic],['linear-transform',linear]]){await card.screenshot({path:path.join(out,`${name}.png`)});}
    await page.setViewportSize({width:360,height:800});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await quadratic.locator('svg').scrollIntoViewIfNeeded();const touchBox=await quadratic.locator('svg').boundingBox();await page.touchscreen.tap(touchBox.x+touchBox.width*.6,touchBox.y+touchBox.height*.5);assert.notEqual(await quadratic.getByRole('slider',{name:'探查位置 x',exact:true}).inputValue(),'1');
    assert.deepEqual(errors,[]);console.log('Tree/math browser passed: every heap step matches tree, shrinking heap, function parameters/tangent/drag/reset, matrix and singular interpolation, touch and 360px.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
