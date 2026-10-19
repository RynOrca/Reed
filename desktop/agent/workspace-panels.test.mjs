import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspacePanels} from '../web/workspace-panels.mjs';

test('快速切换串行关闭原生网页后才展开画布，重复开关最终收起',async()=>{
  const panels=createWorkspacePanels(),events=[];let browser=false,canvas=false;
  panels.register('browser',{isOpen:()=>browser,open:async()=>{assert.equal(canvas,false);browser=true;events.push('browser-open');},close:async()=>{await new Promise(resolve=>setTimeout(resolve,5));browser=false;events.push('browser-hidden');}});
  panels.register('canvas',{isOpen:()=>canvas,open:async()=>{assert.equal(browser,false);canvas=true;events.push('canvas-open');},close:async()=>{canvas=false;events.push('canvas-close');}});
  await Promise.all([panels.toggle('browser'),panels.toggle('canvas'),panels.toggle('browser'),panels.toggle('browser')]);
  assert.deepEqual(events,['browser-open','browser-hidden','canvas-open','canvas-close','browser-open','browser-hidden']);
  assert.equal(browser||canvas,false);
});

test('画布保存失败保留当前面板，队列恢复后仍可正常切换',async()=>{
  const panels=createWorkspacePanels();let canvas=true,browser=false,blocked=true;
  panels.register('canvas',{isOpen:()=>canvas,close:async()=>{if(!blocked)canvas=false;}});
  panels.register('browser',{isOpen:()=>browser,open:async()=>{browser=true;}});
  await assert.rejects(panels.show('browser'),/保存/);assert.equal(browser,false);
  blocked=false;await panels.show('browser');assert.equal(canvas,false);assert.equal(browser,true);
});
