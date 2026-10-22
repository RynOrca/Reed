// Imported parser output is untrusted data. Only explicit physical page indices
// are accepted; a merged Markdown document must never be guessed into pages.
export function mineruPages(value,pageCount){
  const result=new Map();
  const add=(index,text)=>{
    if(!Number.isSafeInteger(index)||index<0||index>=pageCount)throw Error('解析结果页索引超出当前 PDF，请确认文件对应关系');
    if(typeof text!=='string'||!text.trim())return;
    const old=result.get(index)||'';if(old.length+text.length>100000)throw Error('单页解析结果过长');result.set(index,old+(old?'\n\n':'')+text.trim());
  };
  if(Array.isArray(value)){
    for(const block of value){
      if(!block||typeof block!=='object')continue;
      const text=[block.text,block.table_body,...(Array.isArray(block.table_caption)?block.table_caption:[]),...(Array.isArray(block.img_caption)?block.img_caption:[])].filter(s=>typeof s==='string').join('\n');
      if(text.trim())add(block.page_idx,text);
    }
  }else if(Array.isArray(value?.pdf_info)){
    const collect=node=>{
      if(!node||typeof node!=='object')return '';
      if(typeof node.content==='string')return node.content;
      if(typeof node.text==='string')return node.text;
      const children=node.para_blocks||node.blocks||node.lines||node.spans;
      return Array.isArray(children)?children.map(collect).filter(Boolean).join(node.spans?' ':'\n'):'';
    };
    for(const page of value.pdf_info)add(page.page_idx,collect({blocks:page.para_blocks||page.preproc_blocks||[]}));
  }else throw Error('请选择 MinerU content_list.json 或 middle.json，合并 Markdown 无法可靠定位页码');
  if(!result.size)throw Error('解析结果没有带页索引的文字内容');return result;
}
export async function recognizePage({endpoint,image,allowRemote=false,request=fetch,signal}){
  const url=new URL(endpoint);if(url.username||url.password||url.hash)throw Error('识别服务地址不能含账户信息或片段');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(!['http:','https:'].includes(url.protocol)||(!local&&(url.protocol!=='https:'||!allowRemote)))throw Error('远程识别需要 HTTPS 并明确允许发送本页图像');
  if(typeof image!=='string'||image.length>8*1024*1024||!/^iVBORw0KGgo/.test(image))throw Error('本页图像无效或过大');
  const response=await request(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,mimeType:'image/png'}),signal:AbortSignal.any([AbortSignal.timeout(60000),...(signal?[signal]:[])])});
  if(!response.ok)throw Error(`识别服务返回 ${response.status}`);
  if(Number(response.headers.get('content-length'))>1024*1024)throw Error('识别结果过长');
  const reader=response.body.getReader();let size=0,parts=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024)throw Error('识别结果过长');parts.push(value);}}finally{await reader.cancel();}
  const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(typeof value.text!=='string'||!value.text.trim()||value.text.length>100000)throw Error('识别服务须返回非空 text 字段，最多 100000 字符');
  return value.text;
}
