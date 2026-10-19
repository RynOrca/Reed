// Semantic transitions are serialized; pending clicks only update the destination.
export function paintWorkspace(){
  return new Promise(resolve=>{
    const timeout=setTimeout(resolve,200);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve();}));
  });
}
export function createWorkspacePanels({onEmpty=async()=>{},onInterrupt=()=>{}}={}){
  const panels=new Map();let running=null,desired,operation,interruptMotion=()=>{},interrupted=false;
  const active=()=>[...panels].find(([,panel])=>panel.isOpen())?.[0]||null;
  async function hide(name,options){const panel=panels.get(name);if(!panel.isOpen())return;await panel.close(options);if(panel.isOpen())throw Error('面板尚未收起，请先完成保存后重试');}
  async function show(name,operation){
    let handoff=false;
    for(const [other,panel]of panels)if(other!==name&&panel.isOpen()){await hide(other,{keepExpanded:true});handoff=true;}
    try{await (operation||panels.get(name).open)();}
    finally{if(handoff&&![...panels.values()].some(panel=>panel.isOpen()))await onEmpty();}
  }
  async function reconcile(){
    while(desired!==active()){
      const target=desired,work=operation;operation=null;
      const finish=await panels.get(active())?.beforeTransition?.();
      if(desired!==target){await finish?.();continue;}
      const endMotion=typeof document==='undefined'?()=>{}:await beginWorkspaceMotion();interruptMotion=()=>endMotion.cancel?.();
      try{if(target)await show(target,work);else{const name=active();if(name)await hide(name);}}
      catch(error){desired=active();throw error;}
      finally{try{await endMotion();if(desired===active()&&endMotion.pending?.())await endMotion.resume();}finally{interruptMotion=()=>{};await finish?.();}}
      if(desired===target&&active()!==target){desired=active();break;}
    }
    if(desired===null&&!active()){interrupted=false;await onEmpty();if(desired!==active())await reconcile();}
  }
  function request(target,work){
    if(running&&desired!==target){interrupted=true;onInterrupt();interruptMotion();}
    desired=target;operation=work;
    if(!running)running=Promise.resolve().then(reconcile).finally(()=>{running=null;});
    return running;
  }
  return {
    register(name,panel){panels.set(name,panel);},
    show:(name,work)=>{if(!running&&active()===name)return work?work():Promise.resolve();return request(name,work);},
    close:name=>{if((running?desired:active())!==name)return running||Promise.resolve();return request(null);},
    toggle:name=>request((running?desired:active())===name?null:name),
  };
}

// Keep the live chat DOM anchored to the right while the native window grows.
// The chat column keeps its current width for the whole motion so WebView2 only
// relayouts the lighter side pane instead of the whole transcript every frame.
async function beginWorkspaceMotion(){
  if(typeof document==='undefined'||typeof document.querySelector!=='function')return ()=>{};
  const root=document.querySelector('.reed-workspace'),chat=root?.querySelector('.chat-shell');
  if(!root||!chat)return ()=>{};
  const width=chat.getBoundingClientRect().width;
  const previous=root.querySelector(':scope>.workspace-outgoing');
  const outgoing=root.querySelector(':scope>.browser-pane:not([hidden]):not(.workspace-outgoing),:scope>.canvas-pane:not([hidden]):not(.workspace-outgoing)');
  const ghost=outgoing?.cloneNode(true)||previous;
  if(ghost!==previous)previous?.remove();
  if(ghost){ghost.removeAttribute('id');ghost.querySelectorAll('[id],[data-browser],[data-cv]').forEach(el=>{el.removeAttribute('id');el.removeAttribute('data-browser');el.removeAttribute('data-cv');});ghost.removeAttribute('aria-label');ghost.className+=' workspace-outgoing';ghost.inert=true;ghost.setAttribute('aria-hidden','true');root.append(ghost);}
  root.style.setProperty('--motion-chat-width',width+'px');root.classList.add('workspace-moving');
  if(ghost){ghost.style.transition='opacity 160ms linear';ghost.style.opacity='0';}
  let cancelled=false;
  const cleanup=()=>{ghost?.remove();root.classList.remove('workspace-moving');root.style.removeProperty('--motion-chat-width');root.style.removeProperty('transition');};
  const finish=async()=>{
    if(cancelled){cleanup();return;}
    // The native window already snapped to the destination. A pane that keeps
    // the chat width (canvas) needs no settling wait; only a real column change
    // waits for WebView2's relayout and then animates at refresh rate.
    root.classList.remove('workspace-moving');const quick=chat.getBoundingClientRect().width;root.classList.add('workspace-moving');
    if(Math.abs(quick-width)<1){cleanup();return;}
    await new Promise(resolve=>setTimeout(resolve,100));
    if(cancelled){cleanup();return;}
    root.classList.remove('workspace-moving');const target=chat.getBoundingClientRect().width;root.classList.add('workspace-moving');
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(reduced||Math.abs(target-width)<1){cleanup();return;}
    const duration=160,start=performance.now();
    await new Promise(resolve=>{
      const frame=()=>{
        if(cancelled){resolve();return;}
        const t=duration?Math.min(1,(performance.now()-start)/duration):1,ease=t*t*(3-2*t);
        root.style.setProperty('--motion-chat-width',(width+(target-width)*ease)+'px');
        if(ghost)ghost.style.opacity=String(1-ease);
        if(t<1)requestAnimationFrame(frame);else resolve();
      };frame();
    });
    if(cancelled)return;
    cleanup();
  };
  finish.cancel=()=>{cancelled=true;};finish.pending=()=>root.classList.contains('workspace-moving');finish.resume=()=>{cancelled=false;return finish();};return finish;
}
