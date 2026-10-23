import {icon} from './icons.js';
import {materialMarkup,hydrateMaterialIcons,materialKind} from './materials-view.js';
import {createPdfViewer} from './pdf-viewer.js';

export function createMaterials({command:rawCommand,tauri,panels,reading,onError,sessionId}){
  const command=async(type,args={})=>(await rawCommand(type,args,true)).material;
  const workspace=document.querySelector('.reed-workspace'),pane=document.createElement('section');
  pane.className='browser-pane materials-pane';pane.hidden=true;pane.dataset.view='read';pane.setAttribute('aria-label','学习资料');pane.innerHTML=materialMarkup();hydrateMaterialIcons(pane);workspace.prepend(pane);
  const q=name=>pane.querySelector(`[data-m="${name}"]`);
  const entry=document.createElement('button');entry.type='button';entry.id='materials-button';entry.className='icon-button';entry.title='学习资料';entry.setAttribute('aria-label','学习资料');entry.setAttribute('aria-expanded','false');entry.append(icon('folder'));document.getElementById('browser-button').after(entry);
  const dialog=document.createElement('dialog');dialog.className='materials-dialog';pane.append(dialog);
  let opened=false,pdf=null,pdfTask=null,doc=null,lib=null,selectedSubject=null,ownerSession='',importingPath=null,epoch=0,lastDocumentId='',catalog=null;
  const textCache=new Map(),status=text=>{q('status').textContent=text;},isReading=()=>opened&&pane.dataset.view==='read';
  const closeMenus=()=>{q('library').hidden=true;q('more').hidden=true;q('scrim').hidden=true;q('library-toggle').setAttribute('aria-expanded','false');q('more-toggle').setAttribute('aria-expanded','false');};
  function libraryMenu(){const show=q('library').hidden;closeMenus();q('library').hidden=!show;q('scrim').hidden=!show;q('library-toggle').setAttribute('aria-expanded',String(show));}
  function notice(title,copy,action='重试本页'){q('notice-title').textContent=title;q('notice-copy').textContent=copy;q('notice-action').textContent=action;q('notice').hidden=false;}
  async function loadLibrary(){lib??=await import('./vendor/pdfjs/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.mjs',import.meta.url).href;return lib;}
  const viewer=createPdfViewer({host:q('reader'),library:loadLibrary,visible:isReading,
    onState:event=>{
      if(event.state!=='ready')reading.clear();q('loading').hidden=event.state!=='loading'||!event.hasPage;
      if(event.state==='loading'){status(`正在读取 PDF 第 ${event.pageIndex+1} 页…`);if(!event.hasPage)notice('正在读取本页…','正在准备教材画面，请稍候。');}
      if(event.state==='error'){notice('这一页暂时没能打开',event.message);status('页面读取失败；阅读位置已保留，可以重试。');}
      if(event.state==='ready'){q('notice').hidden=true;q('loading').hidden=true;}
    },
    onImage:({pageIndex,pageCount,zoom,mode})=>{
      q('notice').hidden=true;q('page').value=String(pageIndex+1);q('page').max=String(pageCount);q('count').textContent='/ '+pageCount;q('prev').disabled=pageIndex===0;q('next').disabled=pageIndex+1===pageCount;
      q('zoom').value=Math.round(zoom*100)+'%';q('fit').value=mode;q('page-status').textContent=`PDF 第 ${pageIndex+1} 页`;
    },
    onPage:async info=>{
      const key=info.document.id+':'+info.pageIndex;let cached=textCache.get(key);
      if(!cached||cached.source!==info.text){const saved=await command('materials_page',{page:{documentId:info.document.id,revision:info.document.hash,pageIndex:info.pageIndex,pageCount:info.pageCount,text:info.text}});if(!info.current())return;cached={source:info.text,saved};textCache.set(key,cached);if(textCache.size>4)textCache.delete(textCache.keys().next().value);}
      if(!info.current())return;
      status(info.warning||(cached.saved.text?.trim()?`${info.document.title} · PDF 第 ${info.pageIndex+1} 页，可直接在对话中提问。`:'本页没有可读文字层，可在更多菜单导入解析结果或识别本页。'));
      reading.set({documentId:info.document.id,revision:info.document.hash,pageIndex:info.pageIndex,selectionText:'',readingVisible:true});
    },
  });
  async function ask(title,fields){
    if(dialog.open)throw Error('请先完成当前资料操作');
    dialog.returnValue='';dialog.replaceChildren();const form=document.createElement('form');form.method='dialog';const head=document.createElement('header'),heading=document.createElement('h3'),close=document.createElement('button');heading.textContent=title;close.type='button';close.setAttribute('aria-label','关闭');close.append(icon('close'));close.onclick=()=>dialog.close('cancel');head.append(heading,close);form.append(head);
    for(const field of fields){const label=document.createElement('label');label.textContent=field.label;const input=document.createElement(field.options?'select':'input');input.name=field.name;if(field.options)for(const [value,text]of field.options)input.append(new Option(text,value));else{input.type=field.type||'text';input.value=field.value||'';input.required=field.required!==false;if(input.type==='number'){input.min=String(field.min??1);input.max=String(field.max??10);}else input.maxLength=field.maxLength||100;}if(field.value&&field.options)input.value=field.value;label.append(input);form.append(label);if(field.hint){const hint=document.createElement('small');hint.textContent=field.hint;form.append(hint);}}
    const footer=document.createElement('footer'),cancel=document.createElement('button'),confirm=document.createElement('button');cancel.type='button';cancel.textContent='取消';cancel.onclick=()=>dialog.close('cancel');confirm.type='submit';confirm.className='materials-primary';confirm.textContent='确定';footer.append(cancel,confirm);form.append(footer);dialog.append(form);
    return new Promise(resolve=>{form.onsubmit=event=>{event.preventDefault();if(form.reportValidity())dialog.close('ok');};dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'?Object.fromEntries(new FormData(form)):null),{once:true});dialog.showModal();});
  }
  function clearDocument(){
    epoch++;viewer.reset();if(pdfTask)void pdfTask.destroy().catch(()=>{});pdfTask=null;pdf=null;doc=null;textCache.clear();reading.clear();lastDocumentId='';q('title').textContent='学习资料';q('page-status').textContent='';q('count').textContent='';q('loading').hidden=true;
    pane.dispatchEvent(new Event('material-session'));notice('让学习，从一份教材开始','新建科目后导入教材或真题，阅读、提问与练习都在这里。','选择学习资料');
  }
  function setView(name){
    pane.dataset.view=name;q('reader').hidden=name!=='read';q('practice').hidden=name!=='practice';q('assessment').hidden=name!=='paper';for(const [key,active]of [['read-tab',name==='read'],['practice-tab',name!=='read']]){if(active)q(key).setAttribute('aria-current','page');else q(key).removeAttribute('aria-current');}closeMenus();
    if(name!=='read'){reading.clear();viewer.cancel();}else if(pdf&&doc)void viewer.render();
    pane.dispatchEvent(new CustomEvent('material-view',{detail:name}));
  }
  function options(select,items,value){select.replaceChildren(...items.map(item=>new Option(item.title,item.id)));if(value)select.value=value;}
  const showError=error=>{status(String(error.message||error));onError(error);};
  async function refresh(){
    const owner=sessionId(),result=await command('materials_list');if(owner!==sessionId())return null;catalog=result;selectedSubject=result.subject?.id;q('storage').title=result.storagePath||'';
    options(q('subjects'),result.subjects||[],selectedSubject);if(!selectedSubject)q('subjects').prepend(new Option('选择科目',''));options(q('documents'),result.documents||[],doc?.id);
    const list=q('document-list');list.replaceChildren();
    for(const item of result.documents||[]){const button=document.createElement('button'),copy=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('small');button.type='button';button.className='materials-document';button.classList.toggle('selected',item.id===doc?.id);title.textContent=item.title;meta.textContent=[materialKind[item.kind]||'资料',item.pageCount?item.pageCount+' 页':'尚未阅读'].join(' · ');copy.append(title,meta);button.append(icon(item.kind==='textbook'?'book':'activity'),copy);button.onclick=()=>void openDocument(item.id).catch(showError);list.append(button);}
    if(!list.childElementCount){const empty=document.createElement('p');empty.className='materials-library-empty';empty.textContent=selectedSubject?'这个科目还没有资料。':'先新建或选择一个科目。';list.append(empty);}
    pane.dispatchEvent(new CustomEvent('material-library',{detail:{subject:result.subject,documents:result.documents}}));return result;
  }
  async function openDocument(id=q('documents').value,index=0){
    if(!id)return;const owner=sessionId(),name=catalog?.documents.find(item=>item.id===id)?.title||'PDF';clearDocument();const ticket=epoch;lastDocumentId=id;setView('read');q('title').textContent=name;notice('正在打开教材…','正在读取 PDF 文件，请稍候。','重试打开');status('正在打开 PDF…');
    try{
      const library=await loadLibrary();if(ticket!==epoch||owner!==sessionId()||!opened)return;let offset=0,buffer=null,hash;
      do{const chunk=await command('materials_bytes',{documentId:id,offset});if(ticket!==epoch||owner!==sessionId()||!opened)return;buffer??=new Uint8Array(chunk.size);hash=chunk.hash;const binary=atob(chunk.data);for(let i=0;i<binary.length;i++)buffer[offset+i]=binary.charCodeAt(i);offset=chunk.nextOffset;}while(offset<buffer.length);
      const task=library.getDocument({data:buffer,isEvalSupported:false,enableXfa:false,cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,iccUrl:new URL('./vendor/pdfjs/iccs/',import.meta.url).href});pdfTask=task;const loaded=await task.promise;
      if(ticket!==epoch||owner!==sessionId()||!opened){await loaded.destroy();return;}pdf=loaded;doc={id,hash,title:name};viewer.setDocument(pdf,doc);await viewer.render(index);if(ticket===epoch)await refresh();
    }catch(error){if(ticket!==epoch||owner!==sessionId()||!opened)return;notice('这份教材暂时没能打开',String(error.message),'重试打开');status('打开失败，可以重试。');}
  }
  async function importPdf(path){
    if(importingPath===path)return;importingPath=path;
    try{await refresh();if(!selectedSubject){libraryMenu();status('请先新建或选择科目，再导入 PDF。');return;}const owner=sessionId(),data=await ask('导入学习资料',[{name:'title',label:'资料名称',value:path.split(/[\\/]/).pop().replace(/\.pdf$/i,'')},{name:'kind',label:'资料类型',options:Object.entries(materialKind)}]);if(!data||owner!==sessionId())return;status('正在复制 PDF 到专用资料目录…');const result=await command('materials_import',{path,...data});if(owner!==sessionId())return;await refresh();await openDocument(result.id);}finally{if(importingPath===path)importingPath=null;}
  }
  const show=async()=>{opened=true;pane.hidden=false;workspace.classList.add('browser-expanded','browser-mobile-page');entry.setAttribute('aria-expanded','true');await refresh();if(pdf&&doc&&isReading())await viewer.render();};
  const close=async()=>{opened=false;epoch++;viewer.cancel();if(!pdf&&pdfTask){void pdfTask.destroy().catch(()=>{});pdfTask=null;}pane.hidden=true;reading.clear();closeMenus();workspace.classList.remove('browser-expanded','browser-mobile-page');entry.setAttribute('aria-expanded','false');};
  panels.register('materials',{isOpen:()=>opened,open:show,close});entry.onclick=()=>void panels.toggle('materials').catch(onError);q('close').onclick=()=>void panels.close('materials').catch(onError);q('back-chat').onclick=()=>void panels.close('materials').catch(onError);
  q('library-toggle').onclick=libraryMenu;q('library-close').onclick=closeMenus;q('scrim').onclick=closeMenus;
  q('more-toggle').onclick=()=>{const show=q('more').hidden;closeMenus();q('more').hidden=!show;q('scrim').hidden=!show;q('more-toggle').setAttribute('aria-expanded',String(show));};
  q('new').onclick=()=>void(async()=>{const owner=sessionId(),data=await ask('新建科目',[{name:'title',label:'科目名称'}]);if(!data||owner!==sessionId())return;clearDocument();await command('materials_create',data);if(owner===sessionId())await refresh();})().catch(showError);
  q('subjects').onchange=()=>void(async()=>{const owner=sessionId(),id=q('subjects').value;clearDocument();if(id)await command('materials_select',{subjectId:id});if(owner===sessionId()){await refresh();setView('read');libraryMenu();}})().catch(showError);
  const choosePdf=()=>void(async()=>{closeMenus();const path=await tauri.core.invoke('choose_html_file');if(path)await importPdf(path);})().catch(showError);q('import').onclick=q('library-import').onclick=choosePdf;
  q('read-tab').onclick=()=>setView('read');q('practice-tab').onclick=q('library-practice').onclick=()=>setView('practice');
  q('prev').onclick=()=>void viewer.render(viewer.pageIndex-1);q('next').onclick=()=>void viewer.render(viewer.pageIndex+1);q('page').onchange=()=>{const index=Number(q('page').value)-1;if(Number.isSafeInteger(index)&&index>=0&&index<viewer.count)void viewer.render(index);else q('page').value=String(viewer.pageIndex+1);};
  q('zoom-in').onclick=()=>void viewer.scale(viewer.zoom+.15);q('zoom-out').onclick=()=>void viewer.scale(viewer.zoom-.15);q('zoom').onchange=()=>{const value=parseFloat(q('zoom').value);if(Number.isFinite(value))void viewer.scale(value/100);else q('zoom').value=Math.round(viewer.zoom*100)+'%';};q('fit').onchange=()=>void(q('fit').value==='custom'?viewer.scale(viewer.zoom):viewer.fit(q('fit').value));q('fit-width').onclick=()=>{closeMenus();void viewer.fit('width');};q('fit-page').onclick=()=>{closeMenus();void viewer.fit('page');};
  const retry=()=>{closeMenus();if(pdf)void viewer.render();else if(lastDocumentId)void openDocument(lastDocumentId);else libraryMenu();};q('retry').onclick=retry;q('notice-action').onclick=retry;
  q('reader').addEventListener('wheel',event=>{if(!event.ctrlKey||!pdf)return;event.preventDefault();void viewer.scale(viewer.zoom+(event.deltaY<0?.1:-.1));},{passive:false});
  q('reader').addEventListener('mouseup',()=>{const current=viewer.snapshot,selection=getSelection(),text=current?.sheet.querySelector('.textLayer');if(!isReading()||!current||!selection||!text?.contains(selection.anchorNode)||!text.contains(selection.focusNode))return;const selected=selection.toString();if(selected.length>4000){reading.clear();status('选区超过 4000 字符，请缩小选区后提问。');return;}reading.set({documentId:current.document.id,revision:current.document.hash,pageIndex:current.pageIndex,selectionText:selected,readingVisible:true});});
  q('reader').addEventListener('keydown',event=>{if(event.target!==q('reader'))return;if(['ArrowRight','PageDown','ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();void viewer.render(viewer.pageIndex+(['ArrowRight','PageDown'].includes(event.key)?1:-1));}});
  pane.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenus();});
  document.addEventListener('pointerdown',event=>{if(opened&&!pane.contains(event.target))closeMenus();});
  tauri.event.listen('browser-drop',event=>{if(/\.pdf$/i.test(event.payload.path))void panels.show('materials',async()=>{await show();await importPdf(event.payload.path);}).catch(showError);});
  tauri.event.listen('tauri://drag-drop',event=>{const path=event.payload.paths?.find(path=>/\.pdf$/i.test(path));if(path&&(opened||document.querySelector('.browser-pane:not(.materials-pane):not([hidden])')))void panels.show('materials',async()=>{await show();await importPdf(path);}).catch(showError);});
  return {session(){if(ownerSession===sessionId())return;ownerSession=sessionId();if(dialog.open)dialog.close('cancel');clearDocument();setView('read');if(opened)void refresh().catch(showError);},open:async(id,index=0)=>panels.show('materials',async()=>{await show();await openDocument(id,index);}),import:async path=>panels.show('materials',async()=>{await show();await importPdf(path);}),show:()=>panels.show('materials',show),suspendReading:()=>{reading.clear();viewer.cancel();},resumeReading:()=>setView('read'),setView,pane,ask,status,current:()=>{const value=isReading()?viewer.snapshot:null;return value?{document:value.document,pageIndex:value.pageIndex,pageCount:viewer.count,canvas:value.canvas}:null;},subject:()=>catalog?.subject,command,refresh,q,invalidateTextCache:()=>textCache.clear()};
}
