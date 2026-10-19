import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeBrowserTransport} from './native-browser.mjs';
import {AgentBrowser} from './browser.mjs';

test('原生浏览器请求按ID关联，取消只影响指定视图，不接受未知回执',async()=>{
  const sent=[],transport=createNativeBrowserTransport(value=>sent.push(value));
  const preview=transport.request('preview','ensure'),agent=transport.request('agent','Page.enable');
  const rejected=assert.rejects(agent,/取消/);transport.cancelSurface('agent');await rejected;
  assert.equal(transport.receive({type:'other'}),false);
  assert.equal(transport.receive({type:'native_browser_response',id:'unknown',value:{}}),true);
  transport.receive({type:'native_browser_response',id:sent[0].id,value:{engine:'webview2'}});
  assert.deepEqual(await preview,{engine:'webview2'});transport.close();
  await assert.rejects(transport.request('preview','ensure'),/关闭/);
});

test('预热与首次使用去重并复用，启动失败不反复拉起',async()=>{
  let release;const calls=[];
  const native={request:async(surface,method)=>{calls.push({surface,method});if(method==='ensure')await new Promise(resolve=>release=resolve);return {};}};
  const browser=new AgentBrowser('synthetic',{native}),first=browser.start(),second=browser.start();
  assert.equal(calls.length,1);release();await Promise.all([first,second]);await browser.start();
  assert.deepEqual(calls.map(c=>c.method),['ensure','Page.enable']);
  let failures=0;const broken=new AgentBrowser('synthetic',{native:{request:async()=>{failures++;throw Error('模拟初始化失败');}}});
  await assert.rejects(broken.start(),/初始化失败/);await assert.rejects(broken.start(),/初始化失败/);assert.equal(failures,1);
});

test('取消预览读取保留用户页面，取消独立验收会关闭验收页',async()=>{
  const calls=[],native={request:async(surface,method)=>{calls.push({surface,method});return {};},cancelSurface:surface=>calls.push({surface,method:'cancel'})};
  const preview=new AgentBrowser('synthetic',{native,surface:'preview'});await preview.start();preview.cancel();
  assert.equal(preview.nativeReady,true);assert.equal(calls.filter(c=>c.method==='close').length,0);
  const agent=new AgentBrowser('synthetic',{native});await agent.start();agent.cancel();
  assert.equal(agent.nativeReady,false);assert.equal(calls.filter(c=>c.method==='close'&&c.surface==='agent').length,1);
});

test('原生响应错误保持为错误，不回退到系统Edge',async()=>{
  let sent;const native=createNativeBrowserTransport(message=>sent=message);
  const browser=new AgentBrowser('synthetic',{native});const attempt=browser.start();
  native.receive({type:'native_browser_response',id:sent.id,error:'模拟宿主不可用'});
  await assert.rejects(attempt,/宿主不可用/);assert.equal(browser.child,undefined);native.close();
});

test('可见预览窄于320px时仍可连续读取，不沿用模拟视口的最小尺寸',async()=>{
  const native={request:async(_surface,method)=>method==='Page.getNavigationHistory'?{currentIndex:0,entries:[{url:'https://example.org'}]}:{}};
  const browser=new AgentBrowser('synthetic',{native,surface:'preview'});browser.nativeReady=true;
  browser.evaluate=async expression=>expression==='({width:innerWidth,height:innerHeight})'?{width:280,height:500}:{url:'https://example.org',text:'合成窄栏',controls:[]};
  await browser.run({action:'snapshot'});await browser.run({action:'snapshot'});
  assert.deepEqual(browser.viewport,{width:280,height:500});
});
