import {icon} from './icons.js';
export function createMaterials({command:rawCommand,tauri,panels,reading,onError,sessionId}){
  const command=async(type,args={})=>(await rawCommand(type,args,true)).material;
  const workspace=document.querySelector('.reed-workspace'),pane=document.createElement('section');pane.className='browser-pane materials-pane';pane.hidden=true;pane.setAttribute('aria-label','学习资料');
  pane.innerHTML='<header class="browser-toolbar"><strong>学习资料</strong><button type="button" data-m="close" aria-label="关闭学习资料">收起</button></header><div class="materials-library"><label>科目<select data-m="subjects" aria-label="当前科目"></select></label><button data-m="new">新建科目</button><button data-m="import">导入 PDF</button><label>资料<select data-m="documents" aria-label="当前资料"></select></label><button data-m="open">阅读</button></div><div class="materials-tools"><button data-m="prev" aria-label="上一页">上一页</button><label>PDF 页码<input data-m="page" type="number" min="1" value="1"></label><span data-m="count"></span><button data-m="next" aria-label="下一页">下一页</button><button data-m="parsed">导入解析结果</button><button data-m="ocr">识别本页</button></div><p class="materials-status" role="status" data-m="status">新建科目后导入教材或真题。文件会复制到 Reed 专用资料目录。</p><div class="materials-reader" data-m="reader"><div class="materials-page" data-m="sheet"><canvas data-m="canvas"></canvas><div class="textLayer" data-m="text"></div></div></div><div data-m="assessment"></div>';
  workspace.prepend(pane);const q=n=>pane.querySelector(`[data-m="${n}"]`);
  const entry=document.createElement('button');entry.type='button';entry.className='icon-button';entry.title='学习资料';entry.setAttribute('aria-label','学习资料');entry.append(icon('book'));document.getElementById('browser-button').after(entry);
  const dialog=document.createElement('dialog');dialog.className='materials-dialog';pane.append(dialog);
  let opened=false,pdf=null,pdfTask=null,doc=null,pageIndex=0,revision=0,pageTask=null,textLayer=null,lib=null,selectedSubject=null,ownerSession='';
  const status=text=>q('status').textContent=text;
  async function ask(title,fields){
    if(dialog.open)throw Error('请先完成当前资料操作');
    dialog.replaceChildren();const form=document.createElement('form');form.method='dialog';const heading=document.createElement('h3');heading.textContent=title;form.append(heading);
    for(const field of fields){const label=document.createElement('label');label.textContent=field.label;const input=document.createElement(field.options?'select':'input');input.name=field.name;if(field.options)for(const [value,text]of field.options){const option=new Option(text,value);input.append(option);}else{input.type='text';input.value=field.value||'';input.required=field.required!==false;input.maxLength=field.maxLength||100;}label.append(input);form.append(label);}
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='取消';cancel.onclick=()=>dialog.close('cancel');const confirm=document.createElement('button');confirm.type='submit';confirm.textContent='确定';form.append(cancel,confirm);dialog.append(form);
    return new Promise(resolve=>{form.onsubmit=e=>{e.preventDefault();if(form.reportValidity())dialog.close('ok');};dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'?Object.fromEntries(new FormData(form)):null),{once:true});dialog.showModal();});
  }
  function clearDocument(){revision++;pageTask?.cancel();textLayer?.cancel();void pdfTask?.destroy();pdfTask=null;pdf=null;doc=null;reading.clear();q('text').replaceChildren();q('canvas').width=0;q('count').textContent='';}
  function options(select,items,value){select.replaceChildren(...items.map(item=>new Option(item.title,item.id)));if(value)select.value=value;}
  async function refresh(){const owner=sessionId(),result=await command('materials_list',{},true);if(owner!==sessionId())return;selectedSubject=result.subject?.id;options(q('subjects'),result.subjects||[],selectedSubject);if(!selectedSubject)q('subjects').prepend(new Option('选择科目',''));options(q('documents'),result.documents||[],doc?.id);}
  async function library(){await refresh();}
  async function loadLibrary(){lib??=await import('./vendor/pdfjs/pdf.mjs');lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.mjs',import.meta.url).href;return lib;}
  async function render(index){
    if(!pdf||!doc||index<0||index>=pdf.numPages)return;
    pageTask?.cancel();textLayer?.cancel();const ticket=++revision,current=doc,currentPdf=pdf;reading.clear();status('正在读取本页…');
    try{const page=await currentPdf.getPage(index+1);if(ticket!==revision)return;
      const width=Math.max(240,q('reader').clientWidth-32),viewport=page.getViewport({scale:Math.min(2,width/page.getViewport({scale:1}).width)}),ratio=Math.min(devicePixelRatio||1,2),canvas=q('canvas');
      canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';q('sheet').style.width=viewport.width+'px';q('sheet').style.height=viewport.height+'px';
      pageTask=page.render({canvas,canvasContext:canvas.getContext('2d'),viewport,transform:ratio===1?null:[ratio,0,0,ratio,0,0]});await pageTask.promise;if(ticket!==revision)return;
      const content=await page.getTextContent();if(ticket!==revision)return;const text=content.items.map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join('');
      q('text').style.setProperty('--total-scale-factor',viewport.scale);q('text').style.setProperty('--scale-round-x','1px');q('text').style.setProperty('--scale-round-y','1px');q('text').replaceChildren();textLayer=new lib.TextLayer({textContentSource:content,container:q('text'),viewport});await textLayer.render();if(ticket!==revision)return;
      const saved=await command('materials_page',{page:{documentId:current.id,revision:current.hash,pageIndex:index,pageCount:currentPdf.numPages,text:text.slice(0,100000)}},true);if(ticket!==revision)return;
      pageIndex=index;q('page').value=String(index+1);q('count').textContent='/ '+currentPdf.numPages;q('prev').disabled=index===0;q('next').disabled=index+1===currentPdf.numPages;
      reading.set({documentId:current.id,revision:current.hash,pageIndex:index,selectionText:'',readingVisible:opened});
      status(saved.text?.trim()?`${current.title} · PDF 第 ${index+1} 页，可直接在对话中提问。`:'本页没有可读文字层，可导入 MinerU 解析结果或识别本页。');
    }catch(error){if(ticket!==revision||error.name==='RenderingCancelledException')return;reading.clear();status('页面读取失败：'+String(error.message));}
  }
  async function openDocument(id=q('documents').value,index=0){
    if(!id)return;const owner=sessionId();clearDocument();const ticket=revision;status('正在打开 PDF…');
    await loadLibrary();let offset=0,buffer=null,hash;
    do{const chunk=await command('materials_bytes',{documentId:id,offset},true);if(owner!==sessionId()||ticket!==revision)return;
      buffer??=new Uint8Array(chunk.size);hash=chunk.hash;const binary=atob(chunk.data);for(let i=0;i<binary.length;i++)buffer[offset+i]=binary.charCodeAt(i);offset=chunk.nextOffset;
    }while(offset<buffer.length);
    const name=q('documents').selectedOptions[0]?.textContent||'PDF';
    pdfTask=lib.getDocument({data:buffer,isEvalSupported:false,enableXfa:false,cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href});
    const loaded=await pdfTask.promise;if(ticket!==revision){await loaded.destroy();return;}pdf=loaded;doc={id,hash,title:name};await render(index);
  }
  async function importPdf(path){
    await refresh();if(!selectedSubject){status('请先新建或选择科目，再导入 PDF。');return;}
    const owner=sessionId(),data=await ask('导入学习资料',[{name:'title',label:'资料名称',value:path.split(/[\\/]/).pop().replace(/\.pdf$/i,'')},{name:'kind',label:'资料类型',options:[['textbook','教材'],['past-paper','历年真题'],['answer','答案与解析'],['notes','补充资料']]}]);if(!data||owner!==sessionId())return;
    status('正在复制 PDF 到专用资料目录…');const result=await command('materials_import',{path,...data},true);if(owner!==sessionId())return;await refresh();q('documents').value=result.id;await openDocument(result.id);
  }
  const show=async()=>{opened=true;pane.hidden=false;workspace.classList.add('browser-expanded');await library();if(pdf&&doc)await render(pageIndex);};
  const close=async()=>{opened=false;pane.hidden=true;reading.clear();workspace.classList.remove('browser-expanded');};
  panels.register('materials',{isOpen:()=>opened,open:show,close});entry.onclick=()=>void panels.toggle('materials').catch(onError);q('close').onclick=()=>void panels.close('materials').catch(onError);
  q('new').onclick=()=>void(async()=>{const data=await ask('新建科目',[{name:'title',label:'科目名称'}]);if(!data)return;clearDocument();await command('materials_create',data,true);await refresh();})().catch(onError);
  q('subjects').onchange=()=>void(async()=>{clearDocument();if(q('subjects').value)await command('materials_select',{subjectId:q('subjects').value},true);await refresh();})().catch(onError);
  q('import').onclick=()=>void(async()=>{const path=await tauri.core.invoke('choose_html_file');if(path)await importPdf(path);})().catch(onError);
  q('open').onclick=()=>void openDocument().catch(onError);q('prev').onclick=()=>void render(pageIndex-1);q('next').onclick=()=>void render(pageIndex+1);q('page').onchange=()=>void render(Number(q('page').value)-1);
  q('reader').addEventListener('mouseup',()=>{if(!doc||!pdf)return;const selection=getSelection();if(!selection||!q('text').contains(selection.anchorNode))return;reading.set({documentId:doc.id,revision:doc.hash,pageIndex,selectionText:selection.toString().slice(0,4000),readingVisible:opened});});
  tauri.event.listen('browser-drop',event=>{if(/\.pdf$/i.test(event.payload.path))void panels.show('materials',async()=>{await show();await importPdf(event.payload.path);}).catch(onError);});
  tauri.event.listen('tauri://drag-drop',event=>{const path=event.payload.paths?.find(path=>/\.pdf$/i.test(path));if(path&&opened)void importPdf(path).catch(onError);});
  return {session(){if(ownerSession===sessionId())return;ownerSession=sessionId();if(dialog.open)dialog.close('cancel');clearDocument();if(opened)void refresh().catch(onError);},open:async(id,index=0)=>panels.show('materials',async()=>{await show();await openDocument(id,index);}),import:async path=>panels.show('materials',async()=>{await show();await importPdf(path);}),pane,ask,status,current:()=>doc&&pdf?{document:doc,pageIndex,pageCount:pdf.numPages,canvas:q('canvas')}:null,command,refresh,q};
}
