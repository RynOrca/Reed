const workspaceRoot=()=>typeof document!=='undefined'&&typeof document.querySelector==='function'?document.querySelector('.reed-workspace'):null;
// Semantic transitions are serialized; pending clicks only update the destination.
export function paintWorkspace(){
  return new Promise(resolve=>{
    const timeout=setTimeout(resolve,200);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve();}));
  });
}
export function createWorkspacePanels({onEmpty=async()=>{},onInterrupt=()=>{},onExpanded=async()=>{},prepare=async()=>({})}={}){
  const panels=new Map();let running=null,desired,operation,interrupted=false;
  const active=()=>[...panels].find(([,panel])=>panel.isOpen())?.[0]||null;
  async function hide(name,options){const panel=panels.get(name);if(!panel.isOpen())return;await panel.close(options);if(panel.isOpen())throw Error('面板尚未收起，请先完成保存后重试');}
  async function show(name,operation){
    let handoff=false;
    for(const [other,panel]of panels)if(other!==name&&panel.isOpen()){await hide(other,{keepExpanded:true});handoff=true;}
    try{await (operation||panels.get(name).open)();}
    finally{if(handoff&&![...panels.values()].some(panel=>panel.isOpen()))await onEmpty();}
  }
  async function reconcile(){
    for(;;){
      if(desired===active()){
        interrupted=false;
        if(active())await onExpanded();else await onEmpty();
        if(interrupted||desired!==active())continue;
        if(!active()&&typeof document!=='undefined')workspaceRoot()?.classList.remove('workspace-drawer');
        return;
      }
      const target=desired,work=operation;operation=null;
      const finish=await panels.get(active())?.beforeTransition?.();
      if(desired!==target){await finish?.();continue;}
      const endMotion=typeof document==='undefined'?()=>{}:await beginWorkspaceMotion(prepare);
      try{if(target)await show(target,work);else{
        // Keep the outgoing drawer painted until the native clip reaches chat.
        // A reversal keeps that same surface and continues from its current clip.
        await onEmpty();
        const name=active();if(desired===null&&name)await hide(name,{keepExpanded:true});
      }}
      catch(error){desired=active();throw error;}
      finally{try{await endMotion();}finally{await finish?.();}}
      if(desired===target&&active()!==target){desired=active();}
    }
  }
  function request(target,work){
    if(running&&desired!==target){interrupted=true;onInterrupt();}
    desired=target;operation=work;
    if(!running){
      if(typeof document!=='undefined'){const root=workspaceRoot(),chat=root?.querySelector('.chat-shell');if(chat)root.style.setProperty('--workspace-chat-width',chat.getBoundingClientRect().width+'px');root?.classList.add('workspace-transitioning');}
      running=Promise.resolve().then(reconcile).finally(()=>{
        running=null;
        if(typeof document!=='undefined'){const root=workspaceRoot();root?.classList.remove('workspace-moving','workspace-transitioning');root?.style.removeProperty('--motion-chat-width');}
      });
    }
    return running;
  }
  return {
    register(name,panel){panels.set(name,panel);},
    show:(name,work)=>{if(!running&&active()===name)return work?work():Promise.resolve();return request(name,work);},
    close:name=>{if((running?desired:active())!==name)return running||Promise.resolve();return request(null);},
    toggle:name=>request((running?desired:active())===name?null:name),
  };
}

// The live chat keeps one width through native expansion, handoff and collapse.
async function beginWorkspaceMotion(prepare){
  const root=workspaceRoot(),chat=root?.querySelector('.chat-shell');
  if(!root||!chat)return ()=>{};
  const width=chat.getBoundingClientRect().width;
  if(!root.classList.contains('workspace-drawer')){const geometry=await prepare();root.dataset.drawerSide=geometry.side||'left';}
  root.style.setProperty('--workspace-chat-width',width+'px');root.style.setProperty('--motion-chat-width',width+'px');
  root.classList.add('workspace-drawer','workspace-moving');
  // Commit the fixed chat width and side before the native carrier changes.
  await paintWorkspace();
  const finish=()=>paintWorkspace();
  finish.cancel=()=>{};return finish;
}
