import {icon} from './icons.js';
import {renderMarkdown} from './markdown.js';
import {connectionGeometry} from './canvas-geometry.js';

export function createConversationCanvas({command,tauri,prompt,isRunning,onJump,reportError,onUnavailable}){
  const shell=document.querySelector('.chat-shell'),body=document.querySelector('.chat-body'),transcript=document.getElementById('transcript');
  const workspace=document.createElement('div');workspace.className='reed-workspace';shell.before(workspace);
  const pane=document.createElement('section');pane.className='canvas-pane';pane.hidden=true;pane.setAttribute('aria-label','对话画布');
  pane.innerHTML='<header class="canvas-header" data-drag-region><div class="canvas-heading"><span data-cv="mark"></span><div><h2 data-cv="title">对话画布</h2><div class="canvas-meta"><span class="canvas-status" role="status" aria-live="polite"><i></i><span data-cv="status">正在读取…</span><button data-cv="retry" hidden>重试</button></span><span data-cv="counts"></span></div></div></div><div class="canvas-actions"><button data-cv="omitted" title="查看未收录或已隐藏的问答">未收录</button><button data-cv="arrange" title="自动排版" aria-label="自动排版">排版</button><button data-cv="close" class="icon-button" title="收起画布" aria-label="收起画布"></button></div></header><div class="canvas-viewport" data-cv="viewport" tabindex="0" aria-label="问题关系图，拖动空白平移，滚轮缩放"><div class="canvas-help">实线是追问，虚线是跨问题关联</div><div class="canvas-world" data-cv="world"><svg class="canvas-edges" data-cv="edges" aria-hidden="true"></svg><div data-cv="nodes"></div></div><div class="canvas-empty" data-cv="empty" hidden><span data-cv="empty-icon"></span><h3>思路，从一个问题开始</h3><p>有价值的问题会整理在这里；未收录的问答可手动添加。</p></div><div class="canvas-zoom"><button data-cv="minus" title="缩小" aria-label="缩小">−</button><button data-cv="zoom" title="恢复100%缩放">100%</button><button data-cv="plus" title="放大" aria-label="放大">+</button><span></span><button data-cv="fit" title="适应全部节点" aria-label="适应全部节点"></button></div><button class="canvas-minimap" data-cv="minimap" title="回到全图" aria-label="缩略图：回到全图"><svg data-cv="map" aria-hidden="true"></svg></button></div>';
  workspace.append(pane,shell);const q=name=>pane.querySelector(`[data-cv="${name}"]`);
  q('mark').append(icon('graph'));q('empty-icon').append(icon('graph'));q('close').append(icon('chevron'));q('fit').append(icon('fit'));
  const handle=document.createElement('button');handle.id='canvas-button';handle.className='canvas-handle';handle.type='button';handle.hidden=true;handle.title='展开对话画布';handle.setAttribute('aria-label','展开对话画布');handle.setAttribute('aria-expanded','false');handle.append(icon('graph'));body.append(handle);
  const source=document.createElement('aside');source.className='canvas-source';source.hidden=true;source.setAttribute('aria-label','节点问答原文');
  source.innerHTML='<header><h2>问答原文</h2><button type="button" data-source="close" class="icon-button" title="返回当前对话" aria-label="返回当前对话"></button></header><div class="canvas-source-scroll"><div class="canvas-source-question" data-source="question"></div><div class="prose-chat" data-source="answer"></div></div><footer><button type="button" data-source="jump">定位原文</button><button type="button" data-source="rename">修改标题</button><button type="button" data-source="hide">隐藏卡片</button><button type="button" data-source="follow">引用并追问</button></footer>';
  body.append(source);const sq=name=>source.querySelector(`[data-source="${name}"]`);sq('close').append(icon('close'));
  const chip=document.createElement('div');chip.className='canvas-context-chip';chip.hidden=true;const chipText=document.createElement('span'),clear=document.createElement('button');clear.type='button';clear.title='取消问题引用';clear.setAttribute('aria-label','取消问题引用');clear.append(icon('close'));chip.append(icon('graph'),chipText,clear);prompt.before(chip);
  const rename=document.createElement('dialog');rename.className='settings-dialog canvas-rename';rename.innerHTML='<form method="dialog"><h2>修改问题标题</h2><label>画布标题<input name="title" maxlength="100" required></label><p>只修改卡片标题，问答原文保持不变。</p><div><button type="button" data-rename="cancel">取消</button><button type="submit">保存</button></div></form>';document.body.append(rename);
  const candidates=document.createElement('dialog');candidates.className='settings-dialog canvas-candidates';candidates.innerHTML='<header class="settings-head"><h2>未收录问答</h2><button type="button" aria-label="关闭未收录问答">关闭</button></header><p>暂缓、未收录和手动隐藏的问答都保留原文，可随时收录。</p><div class="canvas-candidate-list"></div><p class="canvas-candidates-error" role="status"></p>';document.body.append(candidates);candidates.querySelector('header button').onclick=()=>candidates.close();
  let sessionId='',available=false,opened=false,transitioning=false,epoch=0,graph=null,selected=null,reference=null,sourceValue=null,sourceEpoch=0;
  let scale=1,pan={x:0,y:0},viewTouched=false,gesture=null,zoomTimer=null,saveQueue=Promise.resolve(),dirtyView=null,dirtyNodes=new Map(),saveFailure=false,state='ready';
  let windowQueue=Promise.resolve(),deferredGraph=null;
  function nativeWindow(expanded){const task=windowQueue.then(()=>tauri.core.invoke('set_canvas_window',{expanded}));windowQueue=task.catch(()=>{});return task;}
  const ns='http://www.w3.org/2000/svg',nodeElements=new Map();
  function setStatus(text,next=state){state=next;q('status').textContent=text;q('retry').hidden=next!=='error';pane.dataset.state=next;}
  function closeSource(){sourceEpoch++;source.hidden=true;sourceValue=null;transcript.inert=false;transcript.removeAttribute('aria-hidden');}
  function clearReference(){reference=null;chip.hidden=true;chipText.textContent='';}
  function showReference(node){if(isRunning()){setStatus('请等待当前回复结束后追问');return;}reference={sessionId,nodeId:node.id,title:node.title};chipText.textContent='围绕：'+node.title;chip.hidden=false;closeSource();prompt.focus();}
  function applyGraph(next){if(next?.sessionId!==sessionId||!Array.isArray(next.nodes))return;if(graph&&next.revision<graph.revision)return;if(gesture){if(!deferredGraph||next.revision>=deferredGraph.revision)deferredGraph=next;return;}graph=structuredClone(next);graph.nodes=graph.nodes.filter(n=>!n.hidden);const visible=new Set(graph.nodes.map(n=>n.id));graph.edges=graph.edges.filter(e=>visible.has(e.from)&&visible.has(e.to));for(const [id,change]of dirtyNodes){const node=graph.nodes.find(n=>n.id===id);if(node)Object.assign(node,change);}render();}
  async function flush(){
    clearTimeout(zoomTimer);zoomTimer=null;
    if(!sessionId||!available||(!dirtyView&&!dirtyNodes.size))return saveQueue;
    const id=sessionId,ticket=epoch;
    const task=saveQueue.then(async()=>{
      if(id!==sessionId||ticket!==epoch||!available)return;
      const entries=[...dirtyNodes.entries()],view=dirtyView;if(!entries.length&&!view)return;
      try{const result=await command('canvas_edit',{sessionId:id,patch:{nodes:entries.map(([,change])=>change),...(view?{view}:{})}},true);if(id!==sessionId||ticket!==epoch)return;
        for(const [key,value]of entries)if(dirtyNodes.get(key)===value)dirtyNodes.delete(key);if(dirtyView===view)dirtyView=null;const failed=saveFailure;saveFailure=false;applyGraph(result.graph);if(failed)setStatus('布局已保存','ready');
      }catch(error){if(id===sessionId&&ticket===epoch){saveFailure=true;setStatus('布局未保存，请重试','error');}}
    });saveQueue=task.catch(()=>{});return task;
  }
  function editNode(change){dirtyNodes.set(change.id,{...(dirtyNodes.get(change.id)||{}),...change});const node=graph?.nodes.find(n=>n.id===change.id);if(node)Object.assign(node,change);render();void flush();}
  function saveView(debounce=true){viewTouched=true;dirtyView={x:pan.x,y:pan.y,scale};clearTimeout(zoomTimer);if(debounce)zoomTimer=setTimeout(()=>void flush(),240);else void flush();}
  function bounds(){const nodes=graph?.nodes||[];if(!nodes.length)return {x:0,y:0,w:900,h:600};const x=Math.min(...nodes.map(n=>n.x)),y=Math.min(...nodes.map(n=>n.y));return {x:x-25,y:y-30,w:Math.max(...nodes.map(n=>n.x+226))-x+65,h:Math.max(...nodes.map(n=>n.y+(nodeElements.get(n.id)?.offsetHeight||160)))-y+65};}
  function transform(){q('world').style.transform=`translate(${pan.x}px,${pan.y}px) scale(${scale})`;q('zoom').textContent=Math.round(scale*100)+'%';drawMap();}
  function fit(readable=false,persist=true){if(!opened||!graph?.nodes.length)return;const r=q('viewport').getBoundingClientRect(),b=bounds();scale=Math.max(readable ? 0.7 : 0.1,Math.min(1,(r.width-42)/b.w,(r.height-125)/b.h));pan={x:(r.width-b.w*scale)/2-b.x*scale,y:(r.height-b.h*scale)/2-b.y*scale-30};transform();if(persist)saveView();}
  function zoom(next,x,y){const r=q('viewport').getBoundingClientRect();x??=r.width/2;y??=r.height/2;next=Math.max(.1,Math.min(3,next));const ratio=next/scale;pan={x:x-(x-pan.x)*ratio,y:y-(y-pan.y)*ratio};scale=next;transform();saveView();}
  function svg(tag,attributes){const el=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attributes))el.setAttribute(key,value);return el;}
  function drawMap(){const map=q('map');map.replaceChildren();const b=bounds();map.setAttribute('viewBox',`${b.x} ${b.y} ${b.w} ${b.h}`);for(const n of graph?.nodes||[])map.append(svg('rect',{x:n.x,y:n.y,width:226,height:nodeElements.get(n.id)?.offsetHeight||160,rx:10,class:n.id===selected?'selected':''}));const r=q('viewport').getBoundingClientRect();map.append(svg('rect',{x:-pan.x/scale,y:-pan.y/scale,width:r.width/scale,height:r.height/scale,class:'map-view',rx:8}));}
  function drawEdges(){const root=q('edges');root.replaceChildren();const defs=svg('defs',{});for(const active of [false,true]){const marker=svg('marker',{id:active?'canvas-arrow-active':'canvas-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'});marker.append(svg('path',{d:'M0 1 9 5 0 9',fill:'none',stroke:active?'var(--cv-green)':'var(--cv-wire)','stroke-width':1.4}));defs.append(marker);}root.append(defs);
    for(const edge of graph?.edges||[]){const a=graph.nodes.find(n=>n.id===edge.from),b=graph.nodes.find(n=>n.id===edge.to);if(!a||!b)continue;const active=a.id===selected||b.id===selected,compare=['对比','关联'].includes(edge.type);
      const shape=connectionGeometry({...a,width:226,height:nodeElements.get(a.id)?.offsetHeight||160},{...b,width:226,height:nodeElements.get(b.id)?.offsetHeight||160});
      root.append(svg('path',{d:shape.path,class:'canvas-edge'+(active?' active':'')+(compare?' compare':''),'marker-end':`url(#${active?'canvas-arrow-active':'canvas-arrow'})`}));const label=svg('text',{x:shape.label.x,y:shape.label.y,'text-anchor':'middle',class:'canvas-edge-label'+(active?' active':'')});label.textContent=edge.type;root.append(label);
    }
  }
  function render(){
    const root=q('nodes');root.replaceChildren();nodeElements.clear();const nodes=graph?.nodes||[];
    for(const [index,n]of nodes.entries()){
      const card=document.createElement('article');card.className='canvas-node'+(n.id===selected?' selected':'')+(n.collapsed?' summary-collapsed':'');card.dataset.nodeId=n.id;card.tabIndex=0;card.setAttribute('aria-label',n.title+'，按回车查看原文');card.style.left=n.x+'px';card.style.top=n.y+'px';
      card.innerHTML='<span class="canvas-port in"></span><span class="canvas-port out"></span><div class="canvas-node-top"><span></span><small></small></div><h3></h3><p class="canvas-node-summary"></p><footer><button data-node="fold"></button><button data-node="follow">继续追问</button></footer>';
      card.querySelector('.canvas-node-top span').textContent=String(index+1).padStart(2,'0');card.querySelector('.canvas-node-top small').textContent=n.state==='ready'?'问答':'待整理';card.querySelector('h3').textContent=n.title;card.querySelector('p').textContent=n.summary||'原文已关联，摘要等待整理。';
      const fold=card.querySelector('[data-node="fold"]');fold.textContent=n.collapsed?'展开摘要':'折叠摘要';fold.onclick=e=>{e.stopPropagation();editNode({id:n.id,collapsed:!n.collapsed});};
      card.querySelector('[data-node="follow"]').onclick=e=>{e.stopPropagation();selected=n.id;showReference(n);render();};
      card.onkeydown=e=>{if(e.target!==card)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();void showSource(n.id);}else if(e.key==='F2'){e.preventDefault();selected=n.id;editTitle();}};
      root.append(card);nodeElements.set(n.id,card);
    }
    q('counts').textContent=`${nodes.length} 个问题 · ${graph?.edges.length||0} 条关联`;q('empty').hidden=nodes.length>0;drawEdges();transform();
    if(!viewTouched&&!gesture)requestAnimationFrame(()=>fit(true,false));
  }
  async function showSource(nodeId){
    if(!available||!opened)return;selected=nodeId;render();const ticket=++sourceEpoch,id=sessionId;
    source.hidden=false;sq('question').textContent='正在读取原文…';sq('answer').replaceChildren();transcript.inert=true;transcript.setAttribute('aria-hidden','true');
    try{const result=await command('canvas_source',{sessionId:id,nodeId},true);if(ticket!==sourceEpoch||id!==sessionId||!available)return;sourceValue=result.source;sq('question').textContent=result.source.question;renderMarkdown(sq('answer'),result.source.answer);sq('close').focus();}
    catch(error){if(ticket===sourceEpoch)sq('question').textContent=error.message;}
  }
  function editTitle(){const node=graph?.nodes.find(n=>n.id===selected);if(!node)return;rename.querySelector('input').value=node.title;rename.showModal();rename.querySelector('input').select();}
  rename.querySelector('[data-rename="cancel"]').onclick=()=>rename.close();rename.querySelector('form').onsubmit=e=>{e.preventDefault();const title=rename.querySelector('input').value.trim();if(!title)return;editNode({id:selected,title});rename.close();};
  sq('close').onclick=closeSource;sq('follow').onclick=()=>{const n=graph?.nodes.find(n=>n.id===selected);if(n)showReference(n);};sq('rename').onclick=editTitle;sq('jump').onclick=async()=>{if(!sourceValue)return;try{const messageId=sourceValue.userMessageIds[0];await onJump(messageId);closeSource();}catch(error){sq('question').textContent=error.message;}};
  sq('hide').onclick=async()=>{
    const id=sessionId,ticket=epoch,nodeId=selected;try{const result=await command('canvas_hide',{sessionId:id,nodeId},true);if(id!==sessionId||ticket!==epoch)return;dirtyNodes.delete(nodeId);closeSource();if(reference?.nodeId===nodeId)clearReference();selected=null;applyGraph(result.graph);}catch(error){if(ticket===epoch)sq('question').textContent=error.message;}
  };
  q('omitted').onclick=async()=>{
    const id=sessionId,ticket=epoch,list=candidates.querySelector('.canvas-candidate-list'),error=candidates.querySelector('.canvas-candidates-error');list.replaceChildren();error.textContent='正在读取…';candidates.showModal();
    try{const result=await command('canvas_candidates',{sessionId:id},true);if(id!==sessionId||ticket!==epoch)return;error.textContent=result.items.length?'':'没有未收录的问答。';
      for(const item of result.items){const row=document.createElement('div');row.className='canvas-candidate';const text=document.createElement('div'),title=document.createElement('strong'),state=document.createElement('small');title.textContent=item.title||'图片或附件问题';state.textContent=({hidden:'手动隐藏',ignored:'未收录',deferred:'暂缓判断',pending:'待整理'})[item.status]||'未收录';text.append(title,state);const button=document.createElement('button');button.type='button';button.textContent='收录';button.onclick=async()=>{button.disabled=true;try{const added=await command('canvas_include',{sessionId:id,pairId:item.id},true);if(id!==sessionId||ticket!==epoch)return;applyGraph(added.graph);row.remove();if(!list.childElementCount)error.textContent='没有未收录的问答。';}catch(e){if(ticket===epoch)error.textContent=e.message;}finally{button.disabled=false;}};row.append(text,button);list.append(row);}
    }catch(e){if(ticket===epoch)error.textContent=e.message;}
  };
  async function setOpen(value,{force=false}={}){
    if(transitioning&&!force)return;if(value&&(!available||!sessionId))return;
    transitioning=true;const ticket=++epoch,id=sessionId;
    try{
      if(value){
        workspace.style.setProperty('--canvas-chat-width',shell.getBoundingClientRect().width+'px');workspace.classList.add('canvas-expanded');pane.hidden=false;opened=true;handle.setAttribute('aria-expanded','true');handle.title='收起对话画布';setStatus('正在读取画布…','loading');
        let native;try{native=await nativeWindow(true);}catch(error){opened=false;pane.hidden=true;workspace.classList.remove('canvas-expanded');handle.setAttribute('aria-expanded','false');reportError(error.message);throw error;}if(ticket!==epoch||!available||sessionId!==id)return;
        workspace.style.setProperty('--canvas-chat-width',native.chatWidth+'px');
        const result=await command('canvas_open',{sessionId:id},true);if(ticket!==epoch||sessionId!==id)return;
        viewTouched=result.graph.view.saved===true;if(viewTouched){scale=result.graph.view.scale;pan={x:result.graph.view.x,y:result.graph.view.y};}applyGraph(result.graph);
        if(state==='loading')setStatus('已整理当前对话','ready');
      }else{
        await flush();if(saveFailure&&!force){setStatus('布局尚未保存，请重试后收起','error');return;}
        await command('canvas_close',{sessionId:id},true);await nativeWindow(false);if(ticket!==epoch)return;
        opened=false;pane.hidden=true;workspace.classList.remove('canvas-expanded');handle.setAttribute('aria-expanded','false');handle.title='展开对话画布';closeSource();clearReference();
      }
    }catch(error){if(ticket===epoch){setStatus(error.message,'error');if(!value)reportError(error.message);if(value&&state==='error'&&!graph)q('empty').hidden=false;}}
    finally{if(ticket===epoch)transitioning=false;}
  }
  handle.onclick=()=>{if(!available){onUnavailable?.();return;}void setOpen(!opened);};q('close').onclick=()=>void setOpen(false);
  q('retry').onclick=async()=>{if(saveFailure){await flush();return;}try{setStatus('正在重新整理…','organizing');if(!graph){const result=await command('canvas_open',{sessionId},true);applyGraph(result.graph);}else await command('canvas_retry',{sessionId},true);}catch(error){setStatus(error.message,'error');}};
  q('arrange').onclick=()=>{if(!graph)return;const positions=graph.nodes.map((n,index)=>({id:n.id,x:24+Math.floor(index/4)*290,y:40+(index%4)*190}));for(const change of positions){dirtyNodes.set(change.id,change);Object.assign(graph.nodes.find(n=>n.id===change.id),change);}viewTouched=false;render();fit(true,false);void flush();};
  q('plus').onclick=()=>zoom(scale*1.15);q('minus').onclick=()=>zoom(scale/1.15);q('zoom').onclick=()=>zoom(1);q('fit').onclick=()=>fit();q('minimap').onclick=()=>fit();clear.onclick=clearReference;
  const viewport=q('viewport');viewport.addEventListener('wheel',e=>{if(e.target.closest('button'))return;e.preventDefault();const rect=viewport.getBoundingClientRect();if(!e.ctrlKey&&(e.deltaX||Math.abs(e.deltaY)<30)){pan={x:pan.x-e.deltaX,y:pan.y-e.deltaY};transform();saveView();}else zoom(scale*Math.exp(-e.deltaY*.0014),e.clientX-rect.left,e.clientY-rect.top);},{passive:false});
  viewport.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;const card=e.target.closest('.canvas-node'),node=card?graph?.nodes.find(n=>n.id===card.dataset.nodeId):null;gesture={pointer:e.pointerId,startX:e.clientX,startY:e.clientY,pan:{...pan},node,x:node?.x,y:node?.y,moved:false};if(card)card.classList.add('dragging');else viewport.classList.add('panning');viewport.setPointerCapture(e.pointerId);});
  viewport.addEventListener('pointermove',e=>{if(!gesture||gesture.pointer!==e.pointerId)return;const dx=e.clientX-gesture.startX,dy=e.clientY-gesture.startY;if(Math.hypot(dx,dy)>4)gesture.moved=true;if(!gesture.moved)return;viewTouched=true;if(gesture.node){gesture.node.x=gesture.x+dx/scale;gesture.node.y=gesture.y+dy/scale;const card=nodeElements.get(gesture.node.id);card.style.left=gesture.node.x+'px';card.style.top=gesture.node.y+'px';drawEdges();drawMap();}else{pan={x:gesture.pan.x+dx,y:gesture.pan.y+dy};transform();}});
  function finish(e){if(!gesture||gesture.pointer!==e.pointerId)return;const g=gesture;gesture=null;viewport.classList.remove('panning');for(const el of nodeElements.values())el.classList.remove('dragging');if(viewport.hasPointerCapture(e.pointerId))viewport.releasePointerCapture(e.pointerId);if(g.node){if(g.moved)editNode({id:g.node.id,x:g.node.x,y:g.node.y});else if(e.type!=='pointercancel')void showSource(g.node.id);}else if(g.moved)saveView(false);if(deferredGraph){const next=deferredGraph;deferredGraph=null;applyGraph(next);}}
  viewport.addEventListener('pointerup',finish);viewport.addEventListener('pointercancel',finish);
  viewport.addEventListener('keydown',e=>{if(e.target!==viewport)return;if(['+','=','-','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(['+','=','-'].includes(e.key))zoom(scale*(e.key==='-'?1/1.15:1.15));else{pan.x+=e.key==='ArrowLeft'?40:e.key==='ArrowRight'?-40:0;pan.y+=e.key==='ArrowUp'?40:e.key==='ArrowDown'?-40:0;transform();saveView();}}});
  document.addEventListener('keydown',e=>{if(e.key!=='Escape'||document.querySelector('dialog[open]'))return;if(!source.hidden){closeSource();e.preventDefault();}else if(opened&&e.target.closest?.('.canvas-pane')){void setOpen(false);e.preventDefault();}});
  new ResizeObserver(()=>{if(opened){if(!viewTouched)fit(true,false);else transform();}}).observe(viewport);
  return {
    async session(next,enabled,backendOpen=false,name='',entryEnabled=enabled){
      q('title').textContent=name||'当前对话';
      // Discoverability follows the learning entry; permission still gates every operation.
      handle.hidden=entryEnabled!==true;
      handle.title=enabled===true?(opened?'收起对话画布':'展开对话画布'):'启用对话画布';
      handle.setAttribute('aria-label',handle.title);
      shell.classList.toggle('canvas-available',entryEnabled===true);
      if(next===sessionId&&enabled===available){if(opened&&!backendOpen&&!transitioning){try{await command('canvas_open',{sessionId},true);}catch(error){setStatus(error.message,'error');}}return;}
      const wasOpen=opened;epoch++;sourceEpoch++;clearTimeout(zoomTimer);available=false;closeSource();clearReference();rename.close();candidates.close();graph=null;deferredGraph=null;gesture=null;selected=null;dirtyNodes.clear();dirtyView=null;saveFailure=false;viewTouched=false;nodeElements.clear();q('nodes').replaceChildren();q('edges').replaceChildren();
      opened=false;transitioning=false;pane.hidden=true;workspace.classList.remove('canvas-expanded');handle.setAttribute('aria-expanded','false');sessionId=next||'';available=enabled===true;
      if(wasOpen){try{await nativeWindow(false);}catch(error){reportError(error.message);}}
    },
    event(event){if(event.sessionId!==sessionId||!available||!opened)return;if(event.graph)applyGraph(event.graph);if(saveFailure)return;if(event.state==='organizing')setStatus('正在整理本轮问答…','organizing');else if(event.state==='error')setStatus(event.message||'本轮整理未完成，已有画布已保留','error');else if(event.state==='ready')setStatus('已整理当前对话','ready');},
    reference(){return reference&&available&&reference.sessionId===sessionId?{...reference}:null;},clearReference,flush,
    foreground(){closeSource();if(opened)setStatus('回复完成后将更新画布','ready');},
  };
}
