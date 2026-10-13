import { validCustomState, validCustomTree } from './custom-contract.mjs';
export function createCustomExperience(doc,saved,onChange){
  const root=document.createElement('div');root.className='custom-experience';
  const status=document.createElement('p');status.className='custom-status';status.textContent='正在检查自定义作品…';
  const frame=document.createElement('iframe');frame.className='custom-frame';frame.title=doc.title;frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.src=new URL('custom-frame.html',document.baseURI).href;
  // Offline galleries cannot load file:// scripts from an opaque iframe.
  // The gallery embeds this trusted bundle; production loads the packaged frame.
  if(location.protocol==='file:'&&typeof globalThis.REED_CUSTOM_FRAME_DOCUMENT==='string')frame.srcdoc=globalThis.REED_CUSTOM_FRAME_DOCUMENT;
  const reset=document.createElement('button');reset.type='button';reset.textContent='重置自定义作品';
  const nonce=crypto.randomUUID();let state=structuredClone(validCustomState(doc.stateSchema,saved)?saved:doc.initialState),pending=null,disposed=false,readyResolve;
  const ready=new Promise(resolve=>{readyResolve=resolve;});let diagnostics={status:'loading',state,tree:null};
  const send=(type,args={})=>frame.contentWindow?.postMessage({reedCustom:1,nonce,type,...args},'*');
  const fail=message=>{status.textContent=message;diagnostics={status:'error',message,state};readyResolve(diagnostics);pending?.(diagnostics);pending=null;};
  const timer=setTimeout(()=>fail('自定义作品启动超时'),7000);
  const receive=e=>{
    if(disposed||e.source!==frame.contentWindow||e.data?.reedCustom!==1||e.data.nonce!==nonce)return;
    const r=e.data;
    if(r.type==='error'){clearTimeout(timer);fail(String(r.message).slice(0,500));return;}
    if(r.type==='reset'&&validCustomState(doc.stateSchema,r.state)){state=structuredClone(r.state);onChange(state);}
    if(r.type!=='render'||!validCustomState(doc.stateSchema,r.state)||!validCustomTree(r.tree)||!Number.isFinite(r.height))return;
    clearTimeout(timer);state=structuredClone(r.state);diagnostics={status:'ready',state,tree:r.tree};frame.style.height=`${Math.max(180,Math.min(1200,r.height))}px`;status.textContent='自定义作品 · 运行检查通过，教学内容待核对';
    if(r.commit)onChange(structuredClone(state));readyResolve(diagnostics);pending?.(diagnostics);pending=null;
  };
  addEventListener('message',receive);frame.onload=()=>send('init',{document:doc,state});reset.onclick=()=>send('reset');root.append(status,frame,reset);
  root.ready=ready;root.diagnostics=()=>structuredClone(diagnostics);
  root.runAction=(action,value)=>new Promise(resolve=>{pending=resolve;send('action',{action,value});setTimeout(()=>{if(pending===resolve){pending=null;resolve({status:'error',message:'操作响应超时'});}},2500);});
  root.pause=()=>send('pause');root.resume=()=>send('resume');root.dispose=()=>{disposed=true;clearTimeout(timer);send('pause');removeEventListener('message',receive);observer.disconnect();pending?.({status:'error',message:'作品已关闭'});};
  const observer=new MutationObserver(()=>{if(!root.isConnected)root.dispose();});queueMicrotask(()=>{if(root.isConnected)observer.observe(document.documentElement,{childList:true,subtree:true});});
  return root;
}
