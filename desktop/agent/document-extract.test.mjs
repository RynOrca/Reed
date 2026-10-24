import test from 'node:test';
import assert from 'node:assert/strict';
import {mineruPages,recognizePage} from './document-extract.mjs';
test('MinerU 使用显式物理页索引，拒绝无页码和越界结果',()=>{
  const pages=mineruPages([{page_idx:0,text:'第一页'},{page_idx:1,text:'第二页'},{page_idx:0,type:'equation',text:'x^2'}],2);assert.equal(pages.get(0),'第一页\n\nx^2');
  assert.throws(()=>mineruPages([{text:'无页码'}],2),/页索引/);assert.throws(()=>mineruPages([{page_idx:2,text:'越界'}],2),/页索引/);
  assert.equal(mineruPages({pdf_info:[{page_idx:0,para_blocks:[{lines:[{spans:[{content:'逐页正文'}]}]}]}]},1).get(0),'逐页正文');
});
test('远程 OCR 未获明确发送许可时不发请求',async()=>{
  let called=false;await assert.rejects(recognizePage({endpoint:'https://example.test/ocr',image:'iVBORw0KGgo',request:()=>{called=true;}}),/明确允许/);assert.equal(called,false);
});
