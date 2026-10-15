// Installed executable, migrated role fixture, no model/provider or real user data.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH);
(async()=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'reed-canvas-entry-'));
  const pkg=await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE,data);
  const artifacts=path.resolve(__dirname,'../../dist/canvas-entry-acceptance');await fs.mkdir(artifacts,{recursive:true});
  const roleId='role-test-legacy';await fs.writeFile(path.join(data,'user-config.json'),JSON.stringify({version:1,roles:{activeId:roleId,roles:[{id:'planner',name:'Planner',system:'legacy'},{id:roleId,name:'学习助手',system:'synthetic',learningGoalsEnabled:true,learnerProfileEnabled:true}]},providers:{providers:[]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
  let child,browser,page;const errors=[],checks=[];
  const launch=async()=>{
    child=spawn(path.join(pkg,'Reed.exe'),[],{cwd:pkg,windowsHide:true,env:{...process.env,SUMMON_TEST_DATA_DIR:data,SUMMON_TEST_WEBVIEW_PORT:'9321'},stdio:'ignore'});
    for(let i=0;i<80;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9321',{timeout:500});break;}catch{await new Promise(r=>setTimeout(r,250));}}
    if(!browser)throw Error('WebView2 unavailable');page=browser.contexts()[0].pages()[0];page.on('pageerror',e=>errors.push(String(e)));
    await page.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:30000});
  };
  const stop=async()=>{if(browser){await browser.close();browser=null;}if(child?.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}};
  try{
    await launch();await page.locator('#canvas-button').waitFor({state:'visible'});
    const left=await page.locator('#canvas-button').boundingBox(),right=await page.locator('.goals-handle').boundingBox();assert.ok(Math.abs(left.y-right.y)<2&&Math.abs(left.width-right.width)<2);
    const saved=()=>fs.readFile(path.join(data,'user-config.json'),'utf8').then(JSON.parse);
    assert.equal((await saved()).roles.roles.some(r=>r.id==='planner'),false);assert.equal((await saved()).roles.roles.find(r=>r.id===roleId).canvasEnabled,false);
    checks.push('旧版学习角色缺少新字段，左画布与右目标入口仍对称显示');
    await page.locator('#canvas-button').click();await page.locator('#roles-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#role-canvas-enabled').isChecked(),false);assert.match(await page.locator('#role-error').innerText(),/请启用/);assert.equal(await page.locator('.canvas-pane').isVisible(),false);
    checks.push('未启用时直达当前角色设置，不打开画布或调用模型');
    await page.locator('#role-canvas-enabled').check();await page.locator('.learning-mode-save').filter({hasText:'已保存'}).waitFor();await page.keyboard.press('Escape');assert.equal((await saved()).roles.roles.find(r=>r.id===roleId).canvasEnabled,true);
    await page.locator('#canvas-button').click();await page.locator('.canvas-pane').waitFor({state:'visible'});await page.locator('.canvas-empty').waitFor({state:'visible'});await page.screenshot({path:path.join(artifacts,'canvas-open.png')});await page.locator('[data-cv=close]').click();await page.locator('.canvas-pane').waitFor({state:'hidden'});
    checks.push('从入口启用即时落盘，随后真实展开及收起');
    await stop();await launch();await page.locator('#canvas-button').click();await page.locator('.canvas-pane').waitFor({state:'visible'});assert.equal(await page.locator('#roles-dialog').isVisible(),false);await page.locator('[data-cv=close]').click();await page.locator('.canvas-pane').waitFor({state:'hidden'});
    checks.push('重启后画布权限和入口保留');
    await page.locator('#role-button').click();await page.locator('.role-item').filter({hasText:'学习助手'}).getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#role-canvas-enabled').uncheck();await page.locator('.learning-mode-save').filter({hasText:'已保存'}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#canvas-button').isVisible(),true);
    await page.locator('#canvas-button').click();await page.locator('#roles-dialog').waitFor({state:'visible'});await page.locator('#role-learning-enabled').uncheck();await page.locator('.learning-mode-save').filter({hasText:'已保存'}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#canvas-button').isVisible(),false);assert.equal(await page.locator('.goals-handle').isVisible(),false);
    checks.push('画布子开关关闭仍可找到入口，学习模式关闭后两个入口一起隐藏');
    assert.deepEqual(errors,[]);const report={checks,errors,data,modelCalls:0};await fs.writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }catch(e){if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});throw e;}finally{await stop();}
})().catch(e=>{console.error(e);process.exitCode=1;});
