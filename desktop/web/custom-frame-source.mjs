// This trusted frame is bundled with custom-contract.mjs as a classic script.
// Model JavaScript runs only in a Worker, never in this frame or the chat DOM.
export function customFrameBoot(){
  const root=document.getElementById('root');let owner=null,nonce=null,doc=null,state=null,worker=null,timer=null,pending=null,seq=0,messages=0;
  const send=(type,data={})=>{if(owner)owner.postMessage({reedCustom:1,nonce,type,...data},'*');};
  const stop=()=>{clearTimeout(timer);worker?.terminate();worker=null;pending=null;};
  const error=message=>{stop();root.replaceChildren();const p=document.createElement('p');p.textContent=`作品运行失败：${String(message).slice(0,500)}`;root.append(p);send('error',{message:p.textContent});};
  function workerBoot(){
    const send=self.postMessage.bind(self),listen=self.addEventListener.bind(self);let component=null;
    for(const key of ['fetch','XMLHttpRequest','WebSocket','EventSource','importScripts','Worker','SharedWorker','indexedDB','caches','setTimeout','setInterval'])Object.defineProperty(self,key,{value:undefined,writable:false,configurable:false});
    const ui={text:text=>({type:'text',text:String(text)}),column:children=>({type:'column',children}),row:children=>({type:'row',children})};
    for(const type of ['button','slider','number','select','svg','line','path','circle','rect','polygon','label','point'])ui[type]=props=>({type,...props});
    Object.defineProperty(self,'ui',{value:Object.freeze(ui),writable:false});
    Object.defineProperty(self,'Reed',{value:Object.freeze({register:value=>{if(component)throw new Error('只能注册一次');if(typeof value?.render!=='function'||typeof value?.reduce!=='function')throw new Error('需要 render(state) 和 reduce(state,event)');component=value;}}),writable:false});
    listen('message',event=>{const {id,state,event:action}=event.data;try{if(!component)throw new Error('未调用 Reed.register');const next=action?component.reduce(structuredClone(state),action):state;send({id,state:next,tree:component.render(structuredClone(next))});}catch(e){send({id,error:String(e.message||e).slice(0,500)});}});
  }
  const request=(action=null)=>{
    if(pending)return false;
    if(!worker){start(action);return true;}
    pending={id:++seq,commit:!!action};timer=setTimeout(()=>error('计算超过 1500 毫秒，已终止；可重置作品'),1500);
    worker.postMessage({id:pending.id,state,event:action});return true;
  };
  const dispatch=(action,value)=>request({action,value});
  const html=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function render(node,inSvg=false){
    const type=node.type;
    if(['column','row'].includes(type)){const el=html('div');el.className=type;node.children.forEach(c=>el.append(render(c)));return el;}
    if(type==='text')return html('p',node.text);
    if(type==='button'){const el=html('button',node.label);el.type='button';el.onclick=()=>dispatch(node.action);return el;}
    if(['slider','number','select'].includes(type)){
      const label=html('label'),caption=html('span',node.label),output=html('output',String(node.value));
      const input=html(type==='select'?'select':'input');input.setAttribute('aria-label',node.label);
      if(type==='select')for(const option of node.options){const el=html('option',option);el.value=option;input.append(el);}
      else{input.type=type==='slider'?'range':'number';input.min=node.min;input.max=node.max;input.step=node.step;}
      input.value=node.value;input.oninput=()=>{output.textContent=input.value;};input.onchange=()=>{if(input.reportValidity())dispatch(node.action,type==='select'?input.value:Number(input.value));};label.append(caption,input,output);return label;
    }
    const el=document.createElementNS('http://www.w3.org/2000/svg',type==='label'?'text':type==='point'?'circle':type);
    if(type==='svg'){el.setAttribute('viewBox',node.viewBox);el.setAttribute('role','img');el.setAttribute('aria-label','自定义交互图形');node.children.forEach(c=>el.append(render(c,true)));}
    for(const [key,value] of Object.entries(node)){
      if(['type','children','action','minX','maxX','minY','maxY','text'].includes(key))continue;
      el.setAttribute(key==='strokeWidth'?'stroke-width':key,String(value));
    }
    if(type==='label')el.textContent=node.text;
    if(type==='point'&&node.action){
      el.setAttribute('tabindex','0');el.setAttribute('role','button');el.setAttribute('aria-label','拖动探查点，方向键移动');el.style.touchAction='none';
      let dragging=false;
      el.onpointerdown=e=>{dragging=true;el.setPointerCapture(e.pointerId);};
      el.onpointerup=e=>{if(!dragging)return;dragging=false;const svg=el.ownerSVGElement,p=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());dispatch(node.action,{x:Math.max(node.minX??-1e6,Math.min(node.maxX??1e6,p.x)),y:Math.max(node.minY??-1e6,Math.min(node.maxY??1e6,p.y))});};
      el.onpointercancel=()=>{dragging=false;};
      el.onkeydown=e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(delta){e.preventDefault();dispatch(node.action,{x:Math.max(node.minX??-1e6,Math.min(node.maxX??1e6,node.cx+delta[0])),y:Math.max(node.minY??-1e6,Math.min(node.maxY??1e6,node.cy+delta[1]))});}};
    }
    return el;
  }
  function start(action=null){
    stop();if(!action)root.textContent='正在运行…';
    try{
      const url=URL.createObjectURL(new Blob([`'use strict';(${workerBoot.toString()})();\n`,doc.script],{type:'text/javascript'}));
      worker=new Worker(url);URL.revokeObjectURL(url);
      worker.onerror=e=>{e.preventDefault();error(e.message||'JavaScript错误');};
      worker.onmessage=e=>{
        const reply=e.data;if(!pending||reply?.id!==pending.id)return;
        if(reply.error){error(reply.error);return;}
        if(!validCustomState(doc.stateSchema,reply.state)||!validCustomTree(reply.tree)){error('返回状态或 UI 树不符合 SDK 协议');return;}
        const commit=pending.commit;state=reply.state;stop();
        try{root.replaceChildren(render(reply.tree));}catch(e){error(e.message);return;}
        send('render',{state,tree:reply.tree,commit,height:Math.min(1200,Math.max(180,document.body.scrollHeight))});
      };request(action);
    }catch(e){error(e.message);}
  }
  addEventListener('message',e=>{
    const data=e.data;if(e.source!==parent||data?.reedCustom!==1)return;
    if(!owner){if(data.type!=='init'||typeof data.nonce!=='string'||!validCustomDocument(data.document)||!validCustomState(data.document.stateSchema,data.state))return;owner=e.source;nonce=data.nonce;doc=data.document;state=data.state;start();return;}
    if(data.nonce!==nonce||++messages>5000)return;
    if(data.type==='pause')stop();
    if(data.type==='resume')start();
    if(data.type==='reset'){state=structuredClone(doc.initialState);start();send('reset',{state});}
    if(data.type==='action'&&typeof data.action==='string'&&JSON.stringify(data.value??null).length<=2048)dispatch(data.action,data.value);
  });
}
