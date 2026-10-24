import {icon} from './icons.js';
export function createMaterialOutline({pane,q,command,source,metadata,go,sessionId}){
 let revision=0,job=null,items=[],expanded=new Set(),selected=-1;
 const list=q('outline-list'),hint=q('outline-status'),button=q('outline-toggle');
 function visible(value){q('outline').hidden=!value;button.setAttribute('aria-expanded',String(value));try{localStorage.setItem('reed-material-outline-visible',String(value));}catch{}}
 visible(localStorage.getItem('reed-material-outline-visible')!=='false');button.onclick=()=>visible(q('outline').hidden);q('outline-close').onclick=()=>visible(false);
 function paint(){list.replaceChildren();const stack=[];for(let i=0;i<items.length;i++){const item=items[i];while(stack.length&&items[stack.at(-1)].level>=item.level)stack.pop();const hidden=stack.some(index=>!expanded.has(index));const children=items[i+1]?.level>item.level;if(!hidden){const row=document.createElement('div');row.className='material-toc-row';row.style.setProperty('--toc-level',item.level);row.classList.toggle('selected',item.pageIndex===selected);const toggle=document.createElement('button'),jump=document.createElement('button'),number=document.createElement('small');toggle.type=jump.type='button';toggle.className='material-toc-fold';toggle.append(icon('chevron'));toggle.disabled=!children;toggle.setAttribute('aria-label',(expanded.has(i)?'收起':'展开')+' '+item.title);if(children)toggle.setAttribute('aria-expanded',String(expanded.has(i)));else toggle.style.visibility='hidden';toggle.onclick=()=>{if(expanded.has(i))expanded.delete(i);else expanded.add(i);paint();};jump.className='material-toc-jump';jump.textContent=item.title;jump.title=item.title;jump.onclick=()=>{void go(item.pageIndex);if(pane.clientWidth<520)visible(false);};number.textContent=String(item.pageIndex+1);row.append(toggle,jump,number);list.append(row);}if(children)stack.push(i);}}
 function use(result){items=result.items;expanded=new Set(items.map((_,i)=>i));hint.textContent=result.source==='native'?'文档自带目录 / 标题':'模型分析大纲 · 可与原文核对';paint();}
 async function cancel(){revision++;if(job){const value=job;job=null;void command('materials_outline_cancel',{documentId:value.id,sessionId:value.session}).catch(()=>{});}q('outline-stop').hidden=true;q('outline-generate').disabled=false;}
 async function open(){await cancel();const ticket=revision,pdf=source(),doc=metadata(),owner=sessionId();items=[];paint();if(!pdf||!doc)return;hint.textContent='正在读取文档目录…';q('outline-generate').disabled=true;
  const current=()=>ticket===revision&&source()===pdf&&metadata()?.id===doc.id&&sessionId()===owner;
  try{
   const cached=await command('materials_outline_get',{documentId:doc.id});if(!current())return;if(cached?.items?.length){use(cached);return;}
   const native=await pdf.getOutline?.();if(!current())return;const flat=[];
   async function flatten(nodes,level=0){for(const item of nodes||[]){if(!current())return;if(flat.length>=2000)throw Error('文档目录过大，最多展示2000条');let index=item.pageIndex;
    if(!Number.isSafeInteger(index)){let dest=typeof item.dest==='string'?await pdf.getDestination(item.dest):item.dest;if(Array.isArray(dest)){index=Number.isInteger(dest[0])?dest[0]:await pdf.getPageIndex(dest[0]);}}
    if(Number.isInteger(index)&&index>=0&&index<pdf.numPages&&item.title?.trim())flat.push({title:item.title.trim().slice(0,200),pageIndex:index,level:Math.min(level,5)});await flatten(item.items,level+1);
   }}
   await flatten(native);if(!current())return;if(flat.length){const result=await command('materials_outline_save',{documentId:doc.id,revision:doc.hash,items:flat});if(current())use(result);return;}
   await generate(ticket,pdf,doc,owner);
  }catch(e){if(current())hint.textContent=e.name==='AbortError'?'大纲分析已停止，可重新生成。':String(e.message||e);}finally{if(current()){q('outline-generate').disabled=false;q('outline-stop').hidden=true;}}
 }
 async function generate(ticket,pdf,doc,owner){const current=()=>ticket===revision&&source()===pdf&&sessionId()===owner;job={id:doc.id,session:owner};q('outline-stop').hidden=false;
  for(let i=0;i<pdf.numPages;i++){if(!current())return;hint.textContent=`读取大纲资料 ${i+1} / ${pdf.numPages}…`;const page=await pdf.getPage(i+1),content=await page.getTextContent();if(!current())return;const text=content.items.map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join('').slice(0,100000);await command('materials_page',{page:{documentId:doc.id,revision:doc.hash,pageIndex:i,pageCount:pdf.numPages,text}});}
  if(!current())return;hint.textContent='模型正在分析章节大纲…';const result=await command('materials_outline_generate',{documentId:doc.id,revision:doc.hash});if(current()){job=null;use(result);}
 }
 q('outline-generate').onclick=()=>void(async()=>{await cancel();const doc=metadata(),pdf=source();if(!doc||!pdf){hint.textContent='请先打开资料';return;}const ticket=revision;q('outline-generate').disabled=true;try{await generate(ticket,pdf,doc,sessionId());}catch(e){if(ticket===revision)hint.textContent=String(e.message||e);}finally{if(ticket===revision){q('outline-generate').disabled=false;q('outline-stop').hidden=true;}}})();
 q('outline-stop').onclick=()=>{void cancel();hint.textContent='大纲分析已停止，可重新生成。';};
 return {open,cancel,reset(){void cancel();items=[];hint.textContent='打开资料后显示大纲';paint();},select(index){selected=index;paint();}};
}
