// Browser and materials share the same geometry, pointer and keyboard behavior.
export function createPanelSplitter({workspace,pane,key,label,kind='browser',onChange=()=>{},onDrag=()=>{}}){
  const splitter=document.createElement('div');splitter.className=kind+'-splitter workspace-splitter';splitter.hidden=true;splitter.tabIndex=0;splitter.setAttribute('role','separator');splitter.setAttribute('aria-orientation','vertical');splitter.setAttribute('aria-label',label);splitter.title=label+'；方向键微调，双击恢复默认';
  pane.after(splitter);
  let ratio=.6,dragging=false;
  try{const saved=Number(localStorage.getItem(key));if(Number.isFinite(saved)&&saved>=.25&&saved<=.75)ratio=saved;}catch{}
  function split(value,save=false){
    ratio=Math.max(.25,Math.min(.75,value));
    workspace.style.setProperty('--browser-width',`calc((100% - 6px) * ${ratio})`);
    workspace.style.setProperty('--workspace-chat-width',`${Math.max(0,(workspace.clientWidth-6)*(1-ratio))}px`);
    workspace.classList.add('workspace-width-adjusted');
    splitter.setAttribute('aria-valuemin','25');splitter.setAttribute('aria-valuemax','75');splitter.setAttribute('aria-valuenow',String(Math.round(ratio*100)));splitter.setAttribute('aria-valuetext',`资料占 ${Math.round(ratio*100)}%`);
    if(save)try{localStorage.setItem(key,String(ratio));}catch{}
    onChange();
  }
  function finish(event){if(!dragging)return;dragging=false;workspace.classList.remove('panel-resizing');if(event&&splitter.hasPointerCapture(event.pointerId))splitter.releasePointerCapture(event.pointerId);split(ratio,true);onDrag(false);}
  splitter.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();dragging=true;workspace.classList.add('panel-resizing');splitter.setPointerCapture(event.pointerId);splitter.focus({preventScroll:true});onDrag(true);});
  splitter.addEventListener('pointermove',event=>{if(!dragging)return;const rect=workspace.getBoundingClientRect(),right=workspace.dataset.drawerSide==='right';split((right?rect.right-event.clientX:event.clientX-rect.left)/(rect.width-6));});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])splitter.addEventListener(event,finish);
  splitter.addEventListener('dblclick',()=>split(.6,true));
  splitter.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();const direction=workspace.dataset.drawerSide==='right'?-1:1;split(event.key==='Home'?.6:ratio+(event.key==='ArrowRight'?.03:-.03)*direction,true);});
  new ResizeObserver(()=>{if(!pane.hidden&&!workspace.classList.contains('workspace-transitioning'))split(ratio);}).observe(workspace);
  return {show(){splitter.hidden=false;split(ratio);},hide(){finish();splitter.hidden=true;},splitter};
}
