import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {materialsHarness} from './materials-test-harness.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.SUMMON_PLAYWRIGHT_PATH||'C:/Users/Orca/AppData/Local/Programs/Python/Python314/Lib/site-packages/playwright/driver/package'),execute=promisify(execFile);
const h=await materialsHarness(),data=join(h.root,'native-profile'),output=resolve('dist/acceptance-materials-native');await mkdir(data);await mkdir(output,{recursive:true});
for(const name of ['user-config.json','app-state.json'])await copyFile(join(h.data,name),join(data,name));
const pkg=await require('./isolated-package.cjs')(process.env.SUMMON_TEST_PACKAGE,data),child=spawn(join(pkg,'Reed.exe'),[],{cwd:pkg,windowsHide:true,env:{...process.env,SUMMON_TEST_DATA_DIR:data,SUMMON_TEST_WEBVIEW_PORT:'9336'},stdio:'ignore'});
let browser,page;const errors=[],checks=[];
async function resize(){await execute('powershell',['-NoProfile','-Command',`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ReedMaterialsTest { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int height,uint flags); }'; $testWindow=(Get-Process -Id ${child.pid}).MainWindowHandle; if($testWindow -eq 0){throw 'Test window unavailable'}; if(-not [ReedMaterialsTest]::SetWindowPos($testWindow,[IntPtr]::Zero,40,30,1280,900,0x14)){throw 'Test resize failed'}`],{windowsHide:true});}
async function call(type,args={}){return page.evaluate(async({type,args})=>{
  const id='native-materials-'+crypto.randomUUID();return new Promise(async(resolve,reject)=>{
    let off=()=>{};const timer=setTimeout(()=>{off();reject(Error('Native command timeout '+type));},30000);
    off=await window.__TAURI__.event.listen('agent-event',event=>{const e=event.payload;if(e.id!==id||!['ack','error','done'].includes(e.type))return;off();clearTimeout(timer);e.type==='error'?reject(Error(e.message)):resolve(e);});
    try{await window.__TAURI__.core.invoke('agent_command',{command:{id,type,...args}});}catch(error){off();clearTimeout(timer);reject(error);}
  });
},{type,args});}
try{
  for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error('Isolated Reed exited '+child.exitCode);try{browser=await chromium.connectOverCDP('http://127.0.0.1:9336',{timeout:500});break;}catch{await new Promise(r=>setTimeout(r,300));}}
  assert.ok(browser,'Native WebView2 unavailable');page=browser.contexts()[0].pages().find(p=>!p.url().includes('settings.html'));page.on('pageerror',error=>errors.push(String(error)));await page.locator('#status').filter({hasText:'就绪'}).waitFor({timeout:30000});checks.push('isolated packaged host initialized');
  const state=await call('get_state'),sessionId=state.sessionId;assert.ok(sessionId);await call('materials_create',{sessionId,title:'test-native-数学'});
  await page.getByRole('button',{name:'学习资料',exact:true}).click();await page.locator('.materials-pane').waitFor({state:'visible'});await resize();
  await page.evaluate(path=>window.__TAURI__.event.emit('browser-drop',{path}),h.pdf);await page.locator('dialog[open] input[name=title]').fill('test-native-教材');await page.locator('dialog[open]').getByRole('button',{name:'确定',exact:true}).click();await page.locator('.materials-status').filter({hasText:'可直接在对话中提问'}).waitFor({timeout:30000});
  assert.match(await page.locator('.textLayer').innerText(),/PAGE_ONE_MARKER/);checks.push('packaged CSP permits offline PDF worker/fonts/text layer');
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.locator('.materials-status').filter({hasText:'第 2 页'}).waitFor();await page.getByRole('button',{name:'上一页',exact:true}).click();await page.locator('.materials-status').filter({hasText:'第 1 页'}).waitFor();
  await page.evaluate(()=>{const span=document.querySelector('.textLayer span'),range=document.createRange();range.selectNodeContents(span);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.querySelector('[data-m=reader]').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
  const from=h.requests.length;await page.locator('#prompt').fill('这一步为什么？');await page.locator('#send-button').click();await page.locator('#status').filter({hasText:'就绪'}).waitFor();const request=JSON.stringify(h.requests.slice(from));assert.match(request,/PAGE_ONE_MARKER/);assert.doesNotMatch(request,/PAGE_TWO_FUTURE/);assert.equal(h.requests.length-from,1);checks.push('native main chat captures current page and excludes cached future page');
  await page.screenshot({path:join(output,'native-pdf.png')});
  await page.locator('#prompt').fill('MATH_RENDER_TEST');await page.locator('#send-button').click();await page.locator('#status').filter({hasText:'就绪'}).waitFor();
  assert.ok(await page.locator('#messages code').filter({hasText:'raw_content'}).count());assert.ok(await page.locator('#messages .reed-math math').count());checks.push('native math renders formulas while technical field names stay code');
  await page.getByRole('button',{name:'生成新模拟题',exact:true}).click();await page.locator('dialog[open] input[name=count]').fill('1');await page.locator('dialog[open]').getByRole('button',{name:'确定',exact:true}).click();await page.locator('.practice-question').waitFor({timeout:30000});assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE_TEACHER_EXPLANATION/);await page.locator('.practice-question input[value=A]').check();await page.getByRole('button',{name:'提交并查看解析',exact:true}).click();await page.locator('.practice-result').waitFor();assert.match(await page.locator('.practice-result').innerText(),/PRIVATE_TEACHER_EXPLANATION/);checks.push('native paper generation and post-submission answer unlock');await page.screenshot({path:join(output,'native-paper.png')});
  await page.locator('.materials-pane [data-m=close]').click();await page.locator('.materials-pane').waitFor({state:'hidden'});await resize();await page.locator('#side-chat-button').waitFor();await page.waitForFunction(()=>!document.getElementById('side-chat-button').disabled);await page.locator('#side-chat-button').click();
  const sideFrom=h.requests.length;await page.getByRole('textbox',{name:'侧边消息'}).fill('刚才主对话说了什么？');await page.locator('.side-chat-pane').getByRole('button',{name:'发送',exact:true}).click();await page.locator('[data-side=status]').filter({hasText:'回复完成'}).waitFor();assert.match(JSON.stringify(h.requests.slice(sideFrom)),/SYNTHETIC_REPLY/);checks.push('native side chat receives main conversation text');await page.screenshot({path:join(output,'native-side.png')});
  assert.deepEqual(errors,[]);const report={passed:true,package:process.env.SUMMON_TEST_PACKAGE,checks,pageErrors:errors,modelRequests:h.requests.length,isolated:true};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}await h.close();}
