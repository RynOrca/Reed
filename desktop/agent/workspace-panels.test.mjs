import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspacePanels} from '../web/workspace-panels.mjs';

test('同一轮连点只保留最终关闭目标，不创建过期面板',async()=>{
  const panels=createWorkspacePanels(),events=[];let browser=false,canvas=false;
  panels.register('browser',{isOpen:()=>browser,open:async()=>{assert.equal(canvas,false);browser=true;events.push('browser-open');},close:async()=>{await new Promise(resolve=>setTimeout(resolve,5));browser=false;events.push('browser-hidden');}});
  panels.register('canvas',{isOpen:()=>canvas,open:async()=>{assert.equal(browser,false);canvas=true;events.push('canvas-open');},close:async()=>{canvas=false;events.push('canvas-close');}});
  await Promise.all([panels.toggle('browser'),panels.toggle('canvas'),panels.toggle('browser'),panels.toggle('browser')]);
  assert.deepEqual(events,[]); // Superseded intents must never be replayed.
  assert.equal(browser||canvas,false);
});

test('画布保存失败保留当前面板，队列恢复后仍可正常切换',async()=>{
  const panels=createWorkspacePanels();let canvas=true,browser=false,blocked=true;
  panels.register('canvas',{isOpen:()=>canvas,close:async()=>{if(!blocked)canvas=false;}});
  panels.register('browser',{isOpen:()=>browser,open:async()=>{browser=true;}});
  await assert.rejects(panels.show('browser'),/保存/);assert.equal(browser,false);
  blocked=false;await panels.show('browser');assert.equal(canvas,false);assert.equal(browser,true);
});

test('面板交接保留展开尺寸，目标展开失败才恢复纯聊天窗口',async()=>{
  const calls=[];let browser=true,canvas=false;
  const panels=createWorkspacePanels({onEmpty:async()=>calls.push('collapse')});
  panels.register('browser',{isOpen:()=>browser,open:async()=>{browser=true;},close:async options=>{calls.push(options.keepExpanded);browser=false;}});
  panels.register('canvas',{isOpen:()=>canvas,open:async()=>{canvas=true;},close:async options=>{calls.push(options.keepExpanded);canvas=false;}});
  await panels.show('canvas');assert.deepEqual(calls,[true]);
  await panels.show('browser',async()=>{throw Error('模拟目标打开失败');}).catch(()=>{});
  assert.deepEqual(calls,[true,true,'collapse']);
  await panels.close('canvas');assert.deepEqual(calls,[true,true,'collapse']);
});

test('运行中的过渡只接续最后目标，不回放中间点击',async()=>{
  let browser=false,canvas=false,release,entered;const events=[];
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const panels=createWorkspacePanels();
  panels.register('browser',{isOpen:()=>browser,open:async()=>{browser=true;events.push('browser');entered();await gate;},close:async()=>{browser=false;events.push('close-browser');}});
  panels.register('canvas',{isOpen:()=>canvas,open:async()=>{canvas=true;events.push('canvas');},close:async()=>{canvas=false;}});
  const first=panels.show('browser');await started;
  const pending=[panels.show('canvas'),panels.toggle('browser'),panels.show('canvas')];release();
  await Promise.all([first,...pending]);assert.deepEqual(events,['browser','close-browser','canvas']);assert.equal(canvas,true);
});
