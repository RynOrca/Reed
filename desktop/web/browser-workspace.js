import {icon} from './icons.js';
import {createBrowserMemory} from './browser-memory.js';
import {resolveBrowserAddress,browserFailure} from './browser-address.mjs';
import {paintWorkspace} from './workspace-panels.mjs';

export function createBrowserWorkspace({tauri,command,prompt,onQuote,onPage,panels,onError,onPdf}){
  const workspace=document.querySelector('.reed-workspace'),shell=document.querySelector('.chat-shell');
  const pane=document.createElement('section');pane.className='browser-pane';pane.hidden=true;pane.setAttribute('aria-label','网页预览');
  pane.innerHTML='<header class="browser-toolbar"><button data-browser="back" class="icon-button" title="后退" aria-label="后退"></button><button data-browser="forward" class="icon-button" title="前进" aria-label="前进"></button><button data-browser="reload" class="icon-button" title="刷新" aria-label="刷新"></button><input data-browser="address" aria-label="网址、搜索或 HTML 路径" placeholder="搜索或输入网址" spellcheck="false" autocomplete="off" autocapitalize="off" inputmode="url"><button data-browser="open" class="icon-button" title="打开 HTML 文件" aria-label="打开 HTML 文件"></button><button data-browser="close" class="icon-button" title="关闭网页预览" aria-label="关闭网页预览"></button></header><div class="browser-actions"><span data-browser="status" role="status">输入网址或打开 HTML，边看边聊</span><button data-browser="quote" disabled>引用选中内容</button><button data-browser="read" disabled>读取整页</button></div><div class="browser-viewport" data-browser="viewport"><div class="browser-empty" data-browser="empty"><span data-browser="mark"></span><h2>把网页放在对话旁</h2><p>输入网址、搜索，或打开本地 HTML。<br>选中文字，就能带着原文继续提问。</p><button data-browser="pick">打开 HTML 文件</button></div></div><footer class="browser-footer"><span data-browser="source">页面内容由文件自身提供</span><button data-browser="chat">切换到对话</button></footer>';
  const splitter=document.createElement('div');splitter.className='browser-splitter';splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-label','调整网页与对话宽度');splitter.setAttribute('aria-orientation','vertical');splitter.setAttribute('aria-valuemin','30');splitter.setAttribute('aria-valuemax','75');splitter.setAttribute('aria-valuenow','60');splitter.hidden=true;
  workspace.prepend(pane,splitter);
  const q=name=>pane.querySelector(`[data-browser="${name}"]`);
  for(const [name,glyph] of [['back','chevron'],['forward','chevron'],['reload','history'],['open','folder'],['close','close'],['mark','book']])q(name).append(icon(glyph));
  q('back').classList.add('browser-back');
  const entry=document.createElement('button');entry.type='button';entry.id='browser-button';entry.className='icon-button';entry.title='内置浏览器';entry.setAttribute('aria-label','内置浏览器');entry.setAttribute('aria-expanded','false');entry.append(icon('browser'));document.getElementById('goals-button').before(entry);
  let opened=false,ready=false,dragging=false,pendingBounds=false,layoutQueue=Promise.resolve(),lastBounds='',source='',attempt='',lastShot='',ticket=0,layoutRevision=0;
  let ratio=Number(localStorage.getItem('reed-browser-ratio'))||.6;
  const status=(text,state='ready')=>{q('status').textContent=text;pane.dataset.state=state;pane.setAttribute('aria-busy',String(state==='loading'));};
  const memory=createBrowserMemory({pane,tauri,navigate:value=>openPage(value),isReady:()=>opened&&ready,onBounds:scheduleBounds,onError});
  function quote(data){
    if(!data?.text?.trim())return;
    const action=data.action==='explain'?'请解释这段内容。':data.action==='ask'?'我想追问这段内容：':'';
    onQuote({text:data.text.slice(0,4000),context:String(data.context||'').slice(0,1500),source:String(data.title||data.url||source),url:String(data.url||source),action});
    workspace.classList.remove('browser-mobile-page');prompt.focus();
  }
  function scheduleBounds(){
    if(pendingBounds)return;pendingBounds=true;
    requestAnimationFrame(()=>{
      pendingBounds=false;
      const rect=q('viewport').getBoundingClientRect(),blocked=Boolean(document.querySelector('dialog[open],#history-overlay:not([hidden])'));
      const visible=opened&&ready&&!dragging&&!blocked&&!workspace.classList.contains('workspace-moving')&&rect.width>=100&&rect.height>=100&&getComputedStyle(pane).display!=='none'&&getComputedStyle(q('viewport')).display!=='none';
      const params=visible?{visible,x:rect.x,y:rect.y,width:rect.width,height:rect.height}:{visible:false};
      void applyBounds(params).then(()=>{if(visible)q('viewport').querySelectorAll('.browser-motion-image').forEach(image=>image.remove());}).catch(error=>{if(visible&&opened)status(String(error),'error');});
    });
  }
  function applyBounds(params,force=false){
    const key=JSON.stringify(params);if(!force&&key===lastBounds)return layoutQueue;lastBounds=key;
    const revision=++layoutRevision;
    const task=layoutQueue.catch(()=>{}).then(()=>{
      if(revision!==layoutRevision)return;
      return tauri?.core.invoke('browser_host',{request:{surface:'preview',method:'bounds',params}});
    });
    layoutQueue=task.catch(()=>{lastBounds='';});return task;
  }
  function split(value,save=false){ratio=Math.max(.3,Math.min(.75,value));workspace.style.setProperty('--browser-width',Math.round(ratio*100)+'%');splitter.setAttribute('aria-valuenow',String(Math.round(ratio*100)));if(dragging||save)workspace.style.setProperty('--workspace-chat-width',Math.max(240,workspace.clientWidth*(1-ratio)-6)+'px');if(save)localStorage.setItem('reed-browser-ratio',String(ratio));scheduleBounds();}
  async function show(){
    if(opened)return;
    opened=true;pane.hidden=false;splitter.hidden=false;workspace.classList.add('browser-expanded');entry.setAttribute('aria-expanded','true');split(ratio);
    if(ready&&lastShot){const image=document.createElement('img');image.alt='';image.className='browser-motion-image';image.src='data:image/png;base64,'+lastShot;await image.decode();q('viewport').append(image);}
    try{await tauri.core.invoke('set_canvas_window',{expanded:true,durationMs:matchMedia('(prefers-reduced-motion: reduce)').matches?0:320});}
    catch(error){opened=false;pane.hidden=true;splitter.hidden=true;workspace.classList.remove('browser-expanded');entry.setAttribute('aria-expanded','false');throw error;}
    workspace.classList.toggle('browser-mobile-page',innerWidth<=500);
  }
  async function close({keepExpanded=false}={}){
    await memory.sample();ticket++;opened=false;memory.invalidate();
    // Hide the native surface before changing its parent's layout or size.
    await applyBounds({visible:false},true);
    pane.hidden=true;splitter.hidden=true;q('viewport').querySelectorAll('.browser-motion-image').forEach(image=>image.remove());
    workspace.classList.remove('browser-expanded','browser-mobile-page');entry.setAttribute('aria-expanded','false');
    if(!keepExpanded){await paintWorkspace();}
  }
  async function open(pathOrUrl){
    if(!opened)return;if(!pathOrUrl){scheduleBounds();return;}
    await memory.sample();
    const target=typeof pathOrUrl==='object'?pathOrUrl:{address:pathOrUrl};
    let destination;try{destination=resolveBrowserAddress(target.address);if(destination.path){destination.search=target.search||'';destination.hash=target.hash||'';}}catch(error){status(browserFailure(error),'error');return;}
    attempt=destination.url||destination.path;q('address').value=attempt;q('source').textContent=attempt;
    const revision=++ticket;ready=false;status('正在加载页面…','loading');q('empty').hidden=false;q('read').disabled=true;q('quote').disabled=true;scheduleBounds();
    try{
      const response=await command('browser_preview',destination,true);
      if(revision!==ticket||!opened)return;
      source=attempt;if(document.activeElement!==q('address'))q('address').value=source;q('source').textContent=source;
      const page=JSON.parse(response.result.content.find(b=>b.type==='text').text);
      q('back').disabled=!page.navigation?.canBack;q('forward').disabled=!page.navigation?.canForward;
      ready=true;q('empty').hidden=true;q('read').disabled=false;q('quote').disabled=false;status(page.title||'页面已就绪');scheduleBounds();await memory.loaded(page,destination.path);
    }catch(error){if(revision!==ticket)return;status(browserFailure(error),'error');q('empty').hidden=false;q('empty').querySelector('h2').textContent='页面未能打开';q('empty').querySelector('p').textContent=browserFailure(error);q('pick').textContent='重试';}
  }
  // Navigation may be slow; never hold the panel queue while waiting on a page.
  const openPage=async path=>{await panels.show('browser');return open(path);};
  async function beforeTransition(){
    let proxy;
    if(ready){
      try{
        const visible=await tauri.core.invoke('browser_host',{request:{surface:'preview',method:'visibility'}});const shot=visible.visible?await tauri.core.invoke('browser_host',{request:{surface:'preview',method:'Page.captureScreenshot',params:{format:'png'}}}):{data:lastShot};if(!shot.data)return ()=>scheduleBounds();lastShot=shot.data;
        proxy=document.createElement('img');proxy.className='browser-motion-image';proxy.alt='';proxy.src='data:image/png;base64,'+shot.data;await proxy.decode();q('viewport').append(proxy);
      }catch(error){console.warn('网页切换截图失败',error);}
    }
    await applyBounds({visible:false},true);
    return ()=>{proxy?.remove();scheduleBounds();};
  }
  panels.register('browser',{isOpen:()=>opened,open:show,close,beforeTransition});
  async function pick(){const path=await tauri.core.invoke('choose_html_file');if(path)await (/\.(pdf|pptx)$/i.test(path)&&onPdf?onPdf(path):openPage(path));}
  q('open').onclick=()=>void pick().catch(onError);q('pick').onclick=()=>void (attempt?openPage(attempt):pick()).catch(onError);
  q('close').onclick=()=>void panels.close('browser').catch(onError);
  entry.onclick=()=>{if(opened&&innerWidth<=500&&!workspace.classList.contains('browser-mobile-page')){workspace.classList.add('browser-mobile-page');scheduleBounds();return;}void panels.toggle('browser').catch(onError);};
  q('address').addEventListener('focus',()=>q('address').select());
  q('address').addEventListener('blur',()=>{if(ready&&source)q('address').value=source;});
  q('address').addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(event.key==='Enter'){event.preventDefault();void openPage(q('address').value).catch(onError);}
    if(event.key==='Escape'){event.preventDefault();q('address').value=source||attempt;prompt.focus();}
  });
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();void panels.show('browser').then(()=>{q('address').focus();q('address').select();}).catch(onError);}});
  for(const action of ['back','forward','reload'])q(action).onclick=()=>{
    if(action==='reload'&&!ready&&attempt){void openPage(attempt).catch(onError);return;}
    if(!ready)return;void memory.sample();status('正在加载页面…','loading');
    void command('browser_action',{action},true).then(response=>{const page=JSON.parse(response.result.content.find(b=>b.type==='text').text);status(page.title||'页面已就绪');source=page.url;attempt=source;if(document.activeElement!==q('address'))q('address').value=source;q('back').disabled=!page.navigation?.canBack;q('forward').disabled=!page.navigation?.canForward;void memory.loaded(page);}).catch(error=>status(String(error.message||error),'error'));
  };
  q('quote').onclick=()=>{void tauri.core.invoke('browser_host',{request:{surface:'preview',method:'Runtime.evaluate',params:{expression:"({text:getSelection()?.toString()||'',context:getSelection()?.anchorNode?.parentElement?.innerText?.slice(0,1500)||'',title:document.title,url:location.href})",returnByValue:true}}}).then(result=>{const data=result.result?.value;if(!data?.text?.trim()){status('先在页面里选中一段文字');return;}quote(data);}).catch(onError);};
  q('read').onclick=async()=>{
    const revision=ticket;q('read').disabled=true;status('正在读取网页内容…','loading');
    try{const response=await command('browser_read',{includeImages:true,maxSegments:6},true);if(revision!==ticket||!opened)return;await onPage(response.result);status(response.result.details.coverage.complete?'已加入页面内容，确认后发送':'已加入页面内容；长页或嵌入内容未全部覆盖');workspace.classList.remove('browser-mobile-page');prompt.focus();}catch(error){if(revision===ticket)status(String(error.message||error),'error');}finally{q('read').disabled=!ready;}
  };
  q('chat').onclick=()=>{workspace.classList.toggle('browser-mobile-page');scheduleBounds();if(!workspace.classList.contains('browser-mobile-page'))prompt.focus();};
  splitter.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();dragging=true;splitter.setPointerCapture(event.pointerId);scheduleBounds();});
  splitter.addEventListener('pointermove',event=>{if(dragging){const rect=workspace.getBoundingClientRect();split(workspace.dataset.drawerSide==='right'?1-(event.clientX-rect.left)/rect.width:(event.clientX-rect.left)/rect.width);}});
  const finish=()=>{if(!dragging)return;dragging=false;split(ratio,true);};splitter.addEventListener('pointerup',finish);splitter.addEventListener('lostpointercapture',finish);
  splitter.addEventListener('pointercancel',finish);
  splitter.addEventListener('dblclick',()=>split(.6,true));splitter.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();split(event.key==='Home' ? .6 : ratio+(event.key==='ArrowRight' ? .03 : -.03),true);}});
  new ResizeObserver(scheduleBounds).observe(q('viewport'));
  new MutationObserver(scheduleBounds).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','hidden','class']});
  window.addEventListener('resize',scheduleBounds);
  tauri?.event.listen('browser-selection',event=>quote(event.payload));
  tauri?.event.listen('browser-title',event=>{if(opened&&ready)status(event.payload.title||'页面已就绪');});
  tauri?.event.listen('browser-location',event=>{if(opened&&ready&&event.payload.url!=='about:blank'){source=event.payload.url;attempt=source;memory.navigated(source);if(document.activeElement!==q('address'))q('address').value=source;q('source').textContent=source;q('back').disabled=false;}});
  tauri?.event.listen('tauri://drag-drop',event=>{const path=event.payload?.paths?.find(path=>/\.html?$/i.test(path));if(path)void openPage(path).catch(onError);});
  tauri?.event.listen('browser-drop',event=>{if(event.payload?.path&&!/\.(pdf|pptx)$/i.test(event.payload.path))void openPage(event.payload.path).catch(onError);});
  return {open:openPage,close:()=>panels.close('browser'),event(event){
    if(event.initiator!=='agent')return;
    if(event.state==='loading'){
      if(['navigate','preview'].includes(event.action)){ticket++;ready=false;q('empty').hidden=false;}
      status('模型正在操作当前网页…','loading');void panels.show('browser').catch(onError);
    }else if(event.state==='ready'){
      source=event.url||source;attempt=source;memory.navigated(source);if(document.activeElement!==q('address'))q('address').value=source;q('source').textContent=source;
      ready=true;q('empty').hidden=true;q('read').disabled=false;q('quote').disabled=false;status(event.title||'模型操作已完成');scheduleBounds();
    }else if(event.state==='error'){status(browserFailure(event.message),'error');scheduleBounds();}
  }};
}
