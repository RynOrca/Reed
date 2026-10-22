import test from 'node:test';
import assert from 'node:assert/strict';
import {createPdfViewer} from '../web/pdf-viewer.js';

function fixture(t){
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={setProperty(){}};this.classes=new Set();this.classList={remove:name=>this.classes.delete(name)};this.clientWidth=600;this.clientHeight=800;this.width=0;}
    set className(value){this.classes=new Set(value.split(' '));}
    append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
    querySelectorAll(selector){const result=[];for(const node of this.children){if(selector==='canvas'?node.tag==='canvas':node.classes.has(selector.slice(1)))result.push(node);result.push(...node.querySelectorAll(selector));}return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    getContext(){return {};}
    closest(){return null;}
  }
  const replacements={document:{createElement:tag=>new Element(tag)},getComputedStyle:()=>({paddingLeft:'16',paddingRight:'16',paddingTop:'16',paddingBottom:'16'}),ResizeObserver:class{observe(){}disconnect(){}},devicePixelRatio:1};
  const descriptors=Object.fromEntries(Object.keys(replacements).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value]of Object.entries(replacements))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  t.after(()=>{for(const [key,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const host=new Element('div'),jobs=[],images=[],states=[];
  const pdf={numPages:3,async getPage(index){return{getViewport:({scale})=>({width:400*scale,height:500*scale,scale}),render(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const job={index,resolve,reject,promise,cancel(){reject(Object.assign(Error('cancelled'),{name:'RenderingCancelledException'}));}};jobs.push(job);return job;},async getTextContent(){return{items:[{str:'PAGE_'+index}]};}};}};
  const viewer=createPdfViewer({host,visible:()=>true,library:async()=>({TextLayer:class{async render(){}cancel(){}}}),onState:value=>states.push(value),onImage:value=>images.push(value),onPage:async()=>{}});
  viewer.setDocument(pdf,{id:'test-pdf'});t.after(()=>viewer.destroy());
  return {viewer,host,jobs,images,states};
}
const advance=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};

test('新页失败时保留旧画布，重试成功才替换并释放旧位图',async t=>{
  const f=fixture(t),first=f.viewer.render(0);await advance();f.jobs.at(-1).resolve();await first;
  const old=f.viewer.snapshot;assert.ok(old.canvas.width>0);
  const failed=f.viewer.render(1);await advance();assert.ok(f.host.children.includes(old.sheet));assert.ok(old.canvas.width>0);f.jobs.at(-1).reject(Error('test-raster-failure'));await failed;
  assert.equal(f.viewer.snapshot.canvas,old.canvas);assert.ok(old.canvas.width>0);assert.equal(f.states.at(-1).state,'error');
  const retry=f.viewer.render(1);await advance();f.jobs.at(-1).resolve();await retry;
  assert.equal(f.viewer.snapshot.pageIndex,1);assert.notEqual(f.viewer.snapshot.canvas,old.canvas);assert.equal(old.canvas.width,0);
});

test('快速跳页取消旧任务，只有最后请求可以发布；取消后不再发布',async t=>{
  const f=fixture(t),older=f.viewer.render(0);await advance();const newest=f.viewer.render(2);await advance();f.jobs.at(-1).resolve();await Promise.all([older,newest]);assert.deepEqual(f.images.map(item=>item.pageIndex),[2]);
  const pending=f.viewer.render(1);await advance();f.viewer.cancel();await pending;assert.deepEqual(f.images.map(item=>item.pageIndex),[2]);assert.equal(f.viewer.snapshot.pageIndex,2);
});

test('缩放比例有界，适应宽度和整页使用可见区域尺寸',async t=>{
  const f=fixture(t),first=f.viewer.render(0);await advance();f.jobs.at(-1).resolve();await first;assert.equal(f.viewer.zoom,568/400);
  const zoomed=f.viewer.scale(1.75);await advance();f.jobs.at(-1).resolve();await zoomed;assert.equal(f.viewer.zoom,1.75);assert.equal(f.viewer.snapshot.canvas.width,700);
  f.host.clientWidth=300;f.host.clientHeight=300;const fitted=f.viewer.fit('page');await advance();f.jobs.at(-1).resolve();await fitted;assert.equal(f.viewer.zoom,268/500);assert.equal(f.viewer.mode,'page');
});
