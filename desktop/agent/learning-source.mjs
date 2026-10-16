import {readFile,stat} from 'node:fs/promises';
import {basename,extname} from 'node:path';

export async function readLearningSource(url,capabilities,workspace){
  const match=/^summon-file:[^\r\n]+#L([1-9][0-9]*)$/.exec(String(url||''));
  if(!match||url.length>2400)throw Error('来源需包含有效的笔记行号');
  const path=await capabilities.resolveFile(url,workspace);
  if(!['.md','.txt'].includes(extname(path).toLowerCase()))throw Error('仅支持定位 Markdown 或文本笔记');
  if((await stat(path)).size>1024*1024)throw Error('笔记过大，请在原文件中查看');
  const content=(await readFile(path,'utf8')).split(/\r?\n/),line=Number(match[1]);
  if(!Number.isSafeInteger(line)||line>content.length)throw Error('来源行号已失效，请重新检索笔记');
  const start=Math.max(1,line-6),end=Math.min(content.length,line+16);
  return {path,title:basename(path),line,lines:content.slice(start-1,end).map((text,i)=>({number:start+i,text:text.slice(0,4000)}))};
}
