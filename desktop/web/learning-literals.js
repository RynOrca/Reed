import {createLearningView, isLearningSpec} from './learning-blocks.js';
// 模型偶尔把工具调用写成正文标记，而不是真正的函数调用。这里把它当降级路径处理：
// 只接受能通过同一套结构判定的 JSON，在原位置渲染成真实组件；解析失败则删掉标记，
// 避免用户读到一整段 JSON 或标签。历史记录不因此改变，源文字仍可在会话文件中查看。
const OPEN=/<show_learning\b/gi;
// 从文本中取出第一个完整的 JSON 对象，字符串与转义一并跟踪。
function firstJson(source,from){
  const start=source.indexOf('{',from);
  if(start<0)return null;
  let depth=0,inString=false,escaped=false;
  for(let i=start;i<source.length;i++){
    const char=source[i];
    if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
    if(char==='"'){inString=true;continue;}
    if(char==='{')depth++;
    else if(char==='}'){
      depth--;
      if(depth)continue;
      try{return {text:source.slice(start,i+1),end:i+1};}catch{return null;}
    }
  }
  return null;
}
function payload(source,from,before){
  const limit=before<0?source.length:before;
  const candidate=firstJson(source,from);
  if(!candidate||candidate.end>limit)return null;
  try{
    const value=JSON.parse(candidate.text);
    if(!isLearningSpec(value))return null;
    return value;
  }catch{return null;}
}
// 把一段助手正文切成「普通文字」与「学习块」两类片段，顺序与原文一致。
export function splitLearningLiterals(source){
  const text=String(source??''),spans=[];
  let cursor=0;
  OPEN.lastIndex=0;
  for(let match=OPEN.exec(text);match;match=OPEN.exec(text)){
    const open=match.index;
    const close=text.toLowerCase().indexOf('</show_learning>',open);
    const spec=payload(text,open+match[0].length,close);
    if(!spec){continue;} // 没有可用载荷时留到下面统一清理标记，不打断正文。
    if(open>cursor)spans.push({kind:'text',text:text.slice(cursor,open)});
    spans.push({kind:'learning',spec});
    cursor=close<0?open+match[0].length:close+'</show_learning>'.length;
  }
  if(!spans.length)return [{kind:'text',text}];
  if(cursor<text.length)spans.push({kind:'text',text:text.slice(cursor)});
  return spans;
}
// 去掉无法渲染的标记与其后不成形的 JSON，只留下可读文字。截断的结尾（流式未完成、
// 或模型写到一半被停止）只留下 `<show_learn` 这类残片，也要一起清掉。
export function stripLearningMarkup(source){
  return String(source??'')
    .replace(/<show_learning\b[^>]*>[\s\S]*?<\/show_learning>/gi,' ')
    .replace(/<show_learning\b[^>]*>/gi,' ')
    // 截断的结尾只留下 `<show_learn` 这类残片，也要清掉；普通 HTML 不会命中。
    .replace(/<\/?show(?=-|_|>|\s|$)[^\n>]*>?/gi,' ')
    .replace(/\n{3,}/g,'\n\n');
}
export function hasLearningMarkup(source){return /<\/?show(?=-|_|>|\s|$)/i.test(String(source??''));}
// 正文里出现标记时：能解析的片段渲染成真实组件，剩下的文字正常排版。
// 恢复出来的块没有工具回执，因此不接入作答链路：按钮禁用并说明改用输入框。
export function renderAssistantMarkdown(root,source,render,options){
  if(!hasLearningMarkup(source)){render(root,source,options);return false;}
  const spans=splitLearningLiterals(source),fragment=document.createDocumentFragment();
  let rendered=0;
  for(const span of spans){
    if(span.kind==='learning'){
      try{
        fragment.append(createLearningView(span.spec,{...options.reply,isAvailable:()=>false,unavailableText:'这段内容由模型正文标记恢复，未接入作答链路；请直接用输入框回答。'}).root);
        rendered++;continue;
      }
      catch{fragment.append(document.createTextNode(span.spec.fallbackText||''));continue;}
    }
    const clean=hasLearningMarkup(span.text)?stripLearningMarkup(span.text):span.text;
    if(!clean.trim())continue;
    const host=document.createElement('div');render(host,clean,options);fragment.append(...host.childNodes);
  }
  root.replaceChildren(fragment);
  return rendered>0;
}
