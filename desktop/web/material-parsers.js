export function installMaterialParsers(materials,{tauri,onError}){
  const {q,ask,status,command,current}=materials;let active=false;
  q('parsed').onclick=()=>void(async()=>{
    const page=current();if(!page){status('请先打开 PDF。');return;}
    const path=await tauri.core.invoke('choose_html_file');if(!path)return;
    const confirmation=await ask('确认解析结果与当前 PDF 对应',[{name:'confirm',label:`将解析结果关联至「${page.document.title}」（${page.pageCount} 页）`,options:[['cancel','请选择'],['yes','确认是同一份 PDF']]}]);if(confirmation?.confirm!=='yes')return;
    const result=await command('materials_parse',{documentId:page.document.id,path});status(`已导入 ${result.pageCount} 页解析文字，下次提问按页读取。`);
  })().catch(onError);
  q('ocr').onclick=()=>void(async()=>{
    if(active)return;const page=current();if(!page){status('请先打开 PDF。');return;}
    const settings=await ask('识别本页（可选服务）',[{name:'endpoint',label:'识别服务地址，仅发送当前页图像',maxLength:2000},{name:'consent',label:'发送范围',options:[['local','仅允许本机服务'],['remote','允许发送本页到填写的 HTTPS 服务']]}]);if(!settings)return;
    active=true;q('ocr').disabled=true;status('正在识别本页…');
    try{const image=document.createElement('canvas'),scale=Math.min(1,1800/page.canvas.width);image.width=Math.round(page.canvas.width*scale);image.height=Math.round(page.canvas.height*scale);image.getContext('2d').drawImage(page.canvas,0,0,image.width,image.height);
      await command('materials_ocr',{documentId:page.document.id,revision:page.document.hash,pageIndex:page.pageIndex,endpoint:settings.endpoint,allowRemote:settings.consent==='remote',image:image.toDataURL('image/png').split(',')[1]});status('本页识别结果已缓存，可继续提问。');
    }finally{active=false;q('ocr').disabled=false;}
  })().catch(onError);
}
