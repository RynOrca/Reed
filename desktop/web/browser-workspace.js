import {icon} from './icons.js';

export function createBrowserWorkspace({tauri,command,prompt,onQuote,onPage,panels,onError}){
  const workspace=document.querySelector('.reed-workspace'),shell=document.querySelector('.chat-shell');
  const pane=document.createElement('section');pane.className='browser-pane';pane.hidden=true;pane.setAttribute('aria-label','网页预览');
  pane.innerHTML='<header class="browser-toolbar"><button data-browser="back" class="icon-button" title="后退" aria-label="后退"></button><button data-browser="forward" class="icon-button" title="前进" aria-label="前进"></button><button data-browser="reload" class="icon-button" title="刷新" aria-label="刷新"></button><input data-browser="address" aria-label="文件路径或网页地址" placeholder="打开 HTML 或输入网址"><button data-browser="open" class="icon-button" title="打开 HTML 文件" aria-label="打开 HTML 文件"></button><button data-browser="close" class="icon-button" title="关闭网页预览" aria-label="关闭网页预览"></button></header><div class="browser-actions"><span data-browser="status" role="status">打开 HTML，边看边聊</span><button data-browser="quote" disabled>引用选中内容</button><button data-browser="read" disabled>读取整页</button></div><div class="browser-viewport" data-browser="viewport"><div class="browser-empty" data-browser="empty"><span data-browser="mark"></span><h2>把网页放在对话旁</h2><p>打开模型生成的 HTML，或选择本地文件。<br>选中文字，就能带着原文继续提问。</p><button data-browser="pick">打开 HTML 文件</button></div></div><footer class="browser-footer"><span data-browser="source">页面内容由文件自身提供</span><button data-browser="chat">切换到对话</button></footer>';
  const splitter=document.createElement('div');splitter.className='browser-splitter';splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-label','调整网页与对话宽度');splitter.setAttribute('aria-orientation','vertical');splitter.setAttribute('aria-valuemin','30');splitter.setAttribute('aria-valuemax','75');splitter.setAttribute('aria-valuenow','60');splitter.hidden=true;
  workspace.prepend(pane,splitter);
  const q=name=>pane.querySelector(`[data-browser="${name}"]`);
  for(const [name,glyph] of [['back','chevron'],['forward','chevron'],['reload','history'],['open','folder'],['close','close'],['mark','book']])q(name).append(icon(glyph));
  q('back').classList.add('browser-back');
  const entry=document.createElement('button');entry.type='button';entry.id='browser-button';entry.className='icon-button';entry.title='内置浏览器';entry.setAttribute('aria-label','内置浏览器');entry.setAttribute('aria-expanded','false');entry.append(icon('browser'));document.getElementById('goals-button').before(entry);
  let opened=false,ready=false,dragging=false,pendingBounds=false,layoutQueue=Promise.resolve(),lastBounds='',source='',ticket=0,layoutRevision=0;
  let ratio=Number(localStorage.getItem('reed-browser-ratio'))||.6;
  const status=(text,state='ready')=>{q('status').textContent=text;pane.dataset.state=state;};
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
      const visible=opened&&ready&&!dragging&&!blocked&&rect.width>=100&&rect.height>=100&&getComputedStyle(pane).display!=='none'&&getComputedStyle(q('viewport')).display!=='none';
      const params=visible?{visible,x:rect.x,y:rect.y,width:rect.width,height:rect.height}:{visible:false};
      void applyBounds(params).catch(error=>{if(visible&&opened)status(String(error),'error');});
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
  function split(value,save=false){ratio=Math.max(.3,Math.min(.75,value));workspace.style.setProperty('--browser-width',Math.round(ratio*100)+'%');splitter.setAttribute('aria-valuenow',String(Math.round(ratio*100)));if(save)localStorage.setItem('reed-browser-ratio',String(ratio));scheduleBounds();}
  async function show(){
    if(opened)return;
    await tauri.core.invoke('set_canvas_window',{expanded:true});
    opened=true;pane.hidden=false;splitter.hidden=false;workspace.classList.add('browser-expanded');entry.setAttribute('aria-expanded','true');split(ratio);
    workspace.classList.toggle('browser-mobile-page',innerWidth<=500);
  }
  async function close(){
    ticket++;opened=false;
    // Hide the native surface before changing its parent's layout or size.
    await applyBounds({visible:false},true);
    pane.hidden=true;splitter.hidden=true;workspace.classList.remove('browser-expanded','browser-mobile-page');entry.setAttribute('aria-expanded','false');
    await tauri.core.invoke('set_canvas_window',{expanded:false});
  }
  async function open(pathOrUrl){
    if(!opened)return;if(!pathOrUrl){scheduleBounds();return;}
    const revision=++ticket;ready=false;status('正在加载页面…','loading');q('empty').hidden=false;q('read').disabled=true;q('quote').disabled=true;scheduleBounds();
    try{
      const remote=/^https?:\/\//i.test(pathOrUrl);
      const response=await command('browser_preview',remote?{url:pathOrUrl}:{path:pathOrUrl},true);
      if(revision!==ticket||!opened)return;
      source=pathOrUrl;q('address').value=source;q('source').textContent=source;
      const page=JSON.parse(response.result.content.find(b=>b.type==='text').text);
      q('back').disabled=!page.navigation?.canBack;q('forward').disabled=!page.navigation?.canForward;
      ready=true;q('empty').hidden=true;q('read').disabled=false;q('quote').disabled=false;status(page.title||'页面已就绪');scheduleBounds();
    }catch(error){if(revision!==ticket)return;status(String(error.message||error),'error');q('empty').hidden=false;}
  }
  // Navigation may be slow; never hold the panel queue while waiting on a page.
  const openPage=async path=>{await panels.show('browser');return open(path);};
  panels.register('browser',{isOpen:()=>opened,open:show,close});
  async function pick(){const path=await tauri.core.invoke('choose_html_file');if(path)await openPage(path);}
  q('open').onclick=q('pick').onclick=()=>void pick().catch(onError);
  q('close').onclick=()=>void panels.close('browser').catch(onError);
  entry.onclick=()=>{if(opened&&innerWidth<=500&&!workspace.classList.contains('browser-mobile-page')){workspace.classList.add('browser-mobile-page');scheduleBounds();return;}void panels.toggle('browser').catch(onError);};
  q('address').addEventListener('keydown',event=>{if(event.key==='Enter')void openPage(q('address').value.trim()).catch(onError);});
  for(const action of ['back','forward','reload'])q(action).onclick=()=>{
    if(!ready)return;status('正在加载页面…','loading');
    void command('browser_action',{action},true).then(response=>{const page=JSON.parse(response.result.content.find(b=>b.type==='text').text);status(page.title||'页面已就绪');q('address').value=page.url;q('back').disabled=!page.navigation?.canBack;q('forward').disabled=!page.navigation?.canForward;}).catch(error=>status(String(error.message||error),'error'));
  };
  q('quote').onclick=()=>{void tauri.core.invoke('browser_host',{request:{surface:'preview',method:'Runtime.evaluate',params:{expression:"({text:getSelection()?.toString()||'',context:getSelection()?.anchorNode?.parentElement?.innerText?.slice(0,1500)||'',title:document.title,url:location.href})",returnByValue:true}}}).then(result=>{const data=result.result?.value;if(!data?.text?.trim()){status('先在页面里选中一段文字');return;}quote(data);}).catch(onError);};
  q('read').onclick=async()=>{
    const revision=ticket;q('read').disabled=true;status('正在读取网页内容…','loading');
    try{const response=await command('browser_read',{includeImages:true,maxSegments:6},true);if(revision!==ticket||!opened)return;await onPage(response.result);status(response.result.details.coverage.complete?'已加入页面内容，确认后发送':'已加入页面内容；长页或嵌入内容未全部覆盖');workspace.classList.remove('browser-mobile-page');prompt.focus();}catch(error){if(revision===ticket)status(String(error.message||error),'error');}finally{q('read').disabled=!ready;}
  };
  q('chat').onclick=()=>{workspace.classList.toggle('browser-mobile-page');scheduleBounds();if(!workspace.classList.contains('browser-mobile-page'))prompt.focus();};
  splitter.addEventListener('pointerdown',event=>{if(event.button!==0)return;dragging=true;splitter.setPointerCapture(event.pointerId);scheduleBounds();});
  splitter.addEventListener('pointermove',event=>{if(dragging){const rect=workspace.getBoundingClientRect();split((event.clientX-rect.left)/rect.width);}});
  const finish=()=>{if(!dragging)return;dragging=false;split(ratio,true);};splitter.addEventListener('pointerup',finish);splitter.addEventListener('lostpointercapture',finish);
  splitter.addEventListener('dblclick',()=>split(.6,true));splitter.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();split(event.key==='Home' ? .6 : ratio+(event.key==='ArrowRight' ? .03 : -.03),true);}});
  new ResizeObserver(scheduleBounds).observe(q('viewport'));
  new MutationObserver(scheduleBounds).observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','hidden','class']});
  window.addEventListener('resize',scheduleBounds);
  tauri?.event.listen('browser-selection',event=>quote(event.payload));
  tauri?.event.listen('browser-title',event=>{if(opened&&ready)status(event.payload.title||'页面已就绪');});
  tauri?.event.listen('browser-location',event=>{if(opened&&ready&&event.payload.url!=='about:blank'){source=event.payload.url;q('address').value=source;q('source').textContent=source;q('back').disabled=false;}});
  tauri?.event.listen('tauri://drag-drop',event=>{const path=event.payload?.paths?.find(path=>/\.html?$/i.test(path));if(path)void openPage(path).catch(onError);});
  tauri?.event.listen('browser-drop',event=>{if(event.payload?.path)void openPage(event.payload.path).catch(onError);});
  return {open:openPage,close:()=>panels.close('browser'),event(){}};
}
