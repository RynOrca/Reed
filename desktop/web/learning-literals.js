import {createLearningView, isLearningSpec} from './learning-blocks.js';
// 模型偶尔把工具调用写成正文标记，而不是真正的函数调用。这里把它当降级路径处理：
// 只接受能通过同一套结构判定的内容，在原位置渲染成真实组件；解析失败则删掉标记，
// 避免用户读到一整段 JSON 或标签。历史记录不因此改变，源文字仍可在会话文件中查看。
//
// 实测出现过两种写法，都要认：
//   1. XML 属性式：<show_learning schemaVersion="1" fallbackText="..." blocks="[{'id':...}]">
//      值可能是单引号 Python 字面量、True/False/None，甚至用 &quot; 转义。
//   2. JSON 体式：<show_learning schemaVersion="1" fallbackText="...">{...完整 JSON...}</show_learning>
const OPEN=/<show_learning\b/gi;
const CLOSE='</show_learning>';
// 找到与 start 处引号配对的结束引号，忽略反斜杠转义。
function quotedEnd(source,start,quote){
  let escaped=false;
  for(let i=start+1;i<source.length;i++){
    const char=source[i];
    if(escaped){escaped=false;continue;}
    if(char==='\\'){escaped=true;continue;}
    if(char===quote)return i;
  }
  return -1;
}
// 从 open 处取出整个开始标签；标签没闭合（流式未完成）时返回 null。
function openTag(source,open){
  let quote=null;
  for(let i=open;i<source.length;i++){
    const char=source[i];
    if(quote){if(char===quote)quote=null;continue;}
    if(char==='"'||char==="'"){quote=char;continue;}
    if(char==='>')return {text:source.slice(open,i+1),end:i+1};
  }
  return null;
}
function attributes(tag){
  const head=tag.replace(/^<show_learning\b/i,'').replace(/>$/,''),found={};
  const pattern=/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for(let match=pattern.exec(head);match;match=pattern.exec(head))found[match[1]]=match[3]!==undefined?match[3]:match[4];
  return found;
}
// 属性值可能是单引号 Python 字面量（模型常这么写）：\equiv 这类 LaTeX 反斜杠不算
// 合法 JSON 转义，直接把引号换成双引号会解析失败，因此按字符自己走一遍。
function pythonLiteral(text){
  let index=0;
  const skip=()=>{while(index<text.length&&/\s/.test(text[index]))index++;};
  function value(){
    skip();
    const char=text[index];
    if(char==='['||char==='('){
      index++;const list=[];
      for(;;){skip();if(index>=text.length)throw Error('列表未闭合');if(text[index]===']'||text[index]===')'){index++;return list;}list.push(value());skip();if(text[index]===','){index++;continue;}if(text[index]===']'||text[index]===')'){index++;return list;}throw Error('列表分隔符无效');}
    }
    if(char==='{'){
      index++;const object={};
      for(;;){
        skip();if(index>=text.length)throw Error('对象未闭合');if(text[index]==='}'){index++;return object;}
        const key=value();skip();if(text[index]!==':')throw Error('缺少冒号');index++;
        object[String(key)]=value();skip();
        if(text[index]===','){index++;continue;}
        if(text[index]==='}'){index++;return object;}
        throw Error('对象分隔符无效');
      }
    }
    if(char==='"'||char==="'"){
      index++;let out='';
      for(;;){
        if(index>=text.length)throw Error('字符串未闭合');
        const current=text[index++];
        if(current===char)return out;
        if(current!=='\\'){out+=current;continue;}
        if(index>=text.length)throw Error('转义未完成');
        const escape=text[index++];
        out+=escape==='n'?'\n':escape==='t'?'\t':escape==='r'?'\r':escape==='b'?'\b':escape==='f'?'\f':(escape==='u'||escape==='U'||escape==='x')?current+escape:text.slice(index-2,index);
      }
    }
    const rest=text.slice(index);
    const literal=/^(True|False|None|null|true|false)/.exec(rest);
    if(literal){index+=literal[1].length;return {True:true,true:true,False:false,false:false,None:null,null:null}[literal[1]];}
    const number=/^-?\d+(?:\.\d+)?/.exec(rest);
    if(number){index+=number[0].length;return Number(number[0]);}
    throw Error('无法识别的值');
  }
  const parsed=value();skip();
  if(index<text.length)throw Error('存在多余内容');
  return parsed;
}
// 只保留渲染必需的最小字段：个别字段不合规（例如来源 URL 不对）时，别的块和
// 其余内容仍要能显示，而不是整段退回文字。渲染前的结构判定仍会再拦一层。
function minimal(value){
  // 载荷可能直接就是块数组，也可能包成 {fallbackText, blocks}；统一成形后再最小化。
  const source=Array.isArray(value)?{blocks:value}:value;
  if(!source||typeof source!=='object'||!Array.isArray(source.blocks))return null;
  const blocks=source.blocks.filter(block=>block&&typeof block==='object'&&!Array.isArray(block)).map(block=>{
    const copy={...block};
    if(copy.source&&(typeof copy.source!=='object'||typeof copy.source.label!=='string'||typeof copy.source.url!=='string'))delete copy.source;
    return copy;
  });
  if(!blocks.length)return null;
  const spec={schemaVersion:1,fallbackText:typeof source.fallbackText==='string'&&source.fallbackText.trim()?source.fallbackText:blocks.map(block=>block.fallbackText||block.title||block.term||'').filter(Boolean).join(' ').slice(0,6000),blocks:blocks.slice(0,8)};
  return isLearningSpec(spec)?spec:null;
}
// 属性值里的转义与单引号字面量都可能让 JSON.parse 失败，逐步放宽后再交给同一条校验。
function parseValue(raw,{salvage=false}={}){
  if(typeof raw!=='string'||!raw.trim())return null;
  const text=raw.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  const candidates=[text];
  // Python 风格字面量：外层单引号、True/False/None，按字面量解析而不是替换引号。
  if(/^\s*[\[{(]/.test(text)&&/'/.test(text))candidates.push(()=>pythonLiteral(text));
  for(const candidate of candidates){
    let value;
    // 解析失败与“解析成功但校验不过”要分开：前者换下一种写法，后者进入最小字段抢救。
    try{value=typeof candidate==='function'?candidate():JSON.parse(candidate);}catch{continue;}
    if(isLearningSpec(value))return value;
    if(salvage){const reduced=minimal(value);if(reduced)return reduced;}
  }
  return null;
}
// 从文本中取出第一个完整的 JSON 对象，字符串与转义一并跟踪。
function firstJson(source,from,limit){
  const start=source.indexOf('{',from);
  if(start<0||start>=limit)return null;
  let depth=0,inString=false,escaped=false;
  for(let i=start;i<limit;i++){
    const char=source[i];
    if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
    if(char==='"'){inString=true;continue;}
    if(char==='{')depth++;
    else if(char==='}'){depth--;if(!depth)return {text:source.slice(start,i+1),end:i+1};}
  }
  return null;
}
function bodySpec(source,from,limit){
  for(let candidate=firstJson(source,from,limit);candidate;candidate=firstJson(source,candidate.end,limit)){
    try{
      const value=JSON.parse(candidate.text);
      if(isLearningSpec(value))return {spec:value,end:candidate.end};
      const reduced=minimal(value);
      if(reduced)return {spec:reduced,end:candidate.end};
    }catch{/* 试下一个候选对象 */}
    if(candidate.end>=limit)break;
  }
  return null;
}
// 一段标记里能拿到的最完整内容：属性式承载的块更完整时优先，否则退回 JSON 体。
function extract(source,open,close){
  const limit=close<0?source.length:close;
  const tag=openTag(source,open);
  if(!tag||tag.end>limit)return null;
  const attrs=attributes(tag.text);
  const attributeSpec=parseValue(attrs.blocks,{salvage:true});
  const inner=bodySpec(source,tag.end,limit);
  const end=close<0?Math.max(tag.end,inner?.end||0):close+CLOSE.length;
  if(attributeSpec){
    // 标签上的 fallbackText 是模型给整条消息写的降级文字，比按块拼出来的更完整。
    const envelope=typeof attrs.fallbackText==='string'?attrs.fallbackText.trim():'';
    const spec=envelope&&!attributeSpec.fallbackText.startsWith(envelope)?{...attributeSpec,fallbackText:(envelope+' '+attributeSpec.fallbackText).slice(0,6000)}:attributeSpec;
    return {spec,end};
  }
  if(inner)return {spec:inner.spec,end};
  return null;
}
// 把一段助手正文切成「普通文字」与「学习块」两类片段，顺序与原文一致。
export function splitLearningLiterals(source){
  const text=String(source??''),spans=[];
  let cursor=0;
  OPEN.lastIndex=0;
  for(let match=OPEN.exec(text);match;match=OPEN.exec(text)){
    const open=match.index;
    // 没还原出内容时也要把游标推过这段标记，否则同一个位置会被反复匹配。
    OPEN.lastIndex=open+match[0].length;
    const close=text.toLowerCase().indexOf(CLOSE,open);
    const found=extract(text,open,close);
    if(!found)continue; // 没有可用载荷时留到下面统一清理标记，不打断正文。
    if(open>cursor)spans.push({kind:'text',text:text.slice(cursor,open)});
    spans.push({kind:'learning',spec:found.spec});
    cursor=found.end;
    OPEN.lastIndex=cursor;
  }
  if(!spans.length)return [{kind:'text',text}];
  if(cursor<text.length)spans.push({kind:'text',text:text.slice(cursor)});
  return spans;
}
// 去掉无法渲染的标记与其后的载荷，只留下可读文字。截断的结尾（流式未完成、
// 或模型写到一半被停止）只留下 `<show_learn` 这类残片，也要一起清掉。
export function stripLearningMarkup(source){
  return String(source??'')
    .replace(/<show_learning\b[^>]*>[\s\S]*?<\/show_learning>/gi,' ')
    .replace(/<show_learning\b[^>]*>/gi,' ')
    // 标签里含引号时上面的规则可能匹配不到，这里兜住整个标记到收尾标签。
    .replace(/<show_learning\b[\s\S]*?<\/show_learning>/gi,' ')
    .replace(/<\/?show(?=-|_|>|\s|$)[^\n>]*>?/gi,' ')
    .replace(/\n{3,}/g,'\n\n');
}
export function hasLearningMarkup(source){return /<\/?show(?=-|_|>|\s|$)/i.test(String(source??''));}
// 恢复出来的块没有工具回执，早先只能显示、不能作答。这里给它一个本地稳定标识，
// 作答时作为普通用户消息发送（模型仍能看到完整题干），本地记录已答与题干，
// 历史重放时把同一道的已答状态恢复回来；后端不需要伪造回执。
export function recoveredQuestionKey(messageId,index,blockId){
  return JSON.stringify([String(messageId||''),Number(index)||0,String(blockId||'')]);
}
function defaultStore(){
  try{return globalThis.localStorage||null;}catch{return null;}
}
export function readRecoveredAnswer(key,store=defaultStore()){
  if(!key||!store)return null;
  try{const data=JSON.parse(store.getItem('reed-recovered-answer:'+key)||'null');return data&&typeof data==='object'?data:null;}catch{return null;}
}
export function loadRecoveredAnswers(index,store=defaultStore()){
  if(!index||!store)return {};
  const found={};
  for(const [key,entry] of Object.entries(index)){
    const data=readRecoveredAnswer(key,store);
    if(data?.answered&&typeof data.text==='string')found[key]={question:entry.text,answer:data.answer,text:data.text};
  }
  return found;
}
export function saveRecoveredAnswer(key,{question,answer,text},store=defaultStore()){
  if(!key||!store)return false;
  try{store.setItem('reed-recovered-answer:'+key,JSON.stringify({question:String(question||'').slice(0,2000),answer:String(answer||'').slice(0,2000),text:String(text||'').slice(0,6000),answered:true}));return true;}catch{return false;}
}
// 正文里出现标记时：能解析的片段渲染成真实组件，剩下的文字正常排版。
export function renderAssistantMarkdown(root,source,render,options){
  if(!hasLearningMarkup(source)){render(root,source,options);return false;}
  const spans=splitLearningLiterals(source),fragment=document.createDocumentFragment();
  const recovered=options.recovered||{};
  let rendered=0;
  for(const span of spans){
    if(span.kind==='learning'){
      try{
        const question=(span.spec.blocks||[]).find(block=>['choices','fill'].includes(block.type));
        const key=question?recoveredQuestionKey(options.messageId,rendered,question.id):null;
        // 状态要读“当前”的：作答后就地刷新时必须看到 sending/answered，不能是渲染那一刻的快照。
        const currentState=()=>key&&recovered[key]?{status:'answered',answer:recovered[key].answer}:null;
        // 恢复出来的块不用等下一次整页刷新：提交时就地标记“正在发送/已发送”，
        // 状态另行写入本地存档，历史重放时据此恢复。
        const view=createLearningView(span.spec,{
          isAvailable:()=>Boolean(key)&&!currentState()&&typeof options.canAnswer==='function'&&options.canAnswer(),
          onReply:key&&typeof options.onRecoveredReply==='function'?(block,value)=>{view.setStatus('正在发送回答…');options.onRecoveredReply({key,block,question,value,view});}:undefined,
          getReplyState:currentState,
          getDraft:block=>typeof options.getRecoveredDraft==='function'?options.getRecoveredDraft(key,block):'',
          onDraft:(block,value)=>{if(typeof options.setRecoveredDraft==='function')options.setRecoveredDraft(key,block,value);},
          unavailableText:currentState()?'已回答过这道题；继续追问可以直接用输入框。':'当前不可回答；可通过输入框继续交流。',
        });
        if(key&&question)view.root.dataset.recoveredQuestion=key;
        if(typeof options.onRecoveredView==='function')options.onRecoveredView(view);
        fragment.append(view.root);rendered++;continue;
      }
      catch{fragment.append(document.createTextNode(span.spec.fallbackText||''));continue;}
    }
    const clean=hasLearningMarkup(span.text)?stripLearningMarkup(span.text):span.text;
    if(!clean.trim())continue;
    const host=document.createElement('div');render(host,clean,options);fragment.append(host);
  }
  root.replaceChildren(fragment);
  return rendered>0;
}
