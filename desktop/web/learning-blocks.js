import {renderMarkdown,renderInline} from './markdown.js';
import {renderMath} from './math.js';
import {normalizeMathDelimiters} from './math-auto.js';
const text=(tag,value,cls='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=String(value||'').slice(0,6000);return n;};
// 按钮文字的 aria-label 需要纯文本，这里把公式源码取出来当名字。
const plain=value=>String(value||'').replace(/\$([^$]*)\$/g,'$1').replace(/\\\(([^)]*)\\\)/g,'$1');
export const replyText=(block,answer)=>block.type==='fill'?`关于「${block.title}」：\n${block.label} ${answer.trim()}`:`关于「${block.title}」：${answer.replyText}`;
const blockTypes=new Set(['flow','compare','result','derivation','callout','reveal','term','choices','fill']);
const visible=value=>typeof value==='string'&&value.trim();
// 与 Agent 端校验保持同一条底线；这里只用于能安全渲染的判定，不能替代后端拒收。
export function isLearningSpec(spec){
  return Boolean(spec)&&typeof spec==='object'&&!Array.isArray(spec)&&spec.schemaVersion===1&&Array.isArray(spec.blocks)&&spec.blocks.length>0&&spec.blocks.length<=8&&spec.blocks.every(block=>block&&typeof block==='object'&&!Array.isArray(block)&&blockTypes.has(block.type)&&block.id&&typeof block.id==='string');
}
function blockView(b,{getReplyState,getDraft,onDraft,onReply,onStatus=()=>{},isAvailable,controls,refresh}){
  const section=document.createElement('section');section.className='learning-block learning-'+b.type;section.dataset.blockId=b.id;
  // [^1] 这类脚注在正文里渲染成链接，来源清单附在块末，避免原样显示标记。
  const notes=new Map();
  // 所有可能出现数学的字段都按行内富文本渲染：模型写 $c_1$ 时排版成公式；
  // 写成 c = g^m r^n 这种没有定界符的近似 LaTeX 时，先补齐定界符再渲染。
  const rich=(tag,value,cls='')=>{const n=document.createElement(tag);n.className=cls;renderInline(n,normalizeMathDelimiters(String(value||'')).slice(0,6000),{notes});return n;};
  const body=(host,value)=>{const n=document.createElement('div');renderMarkdown(n,normalizeMathDelimiters(String(value||'')).slice(0,2400),{notes});host.append(n);};
  const list=(values,max)=>{if(!Array.isArray(values)||!values.length||values.length>max)throw Error('无效学习列表');return values;};
  if(b.title&&!['reveal','callout'].includes(b.type))section.append(rich('h3',b.title));
  switch(b.type){
    case 'flow':{const grid=document.createElement('div');grid.className=b.layout==='timeline'?'learning-timeline':'learning-path';for(const [i,item]of list(b.nodes,6).entries()){const node=document.createElement('div');node.className='learning-node';node.append(rich('small',item.label),rich('strong',item.value));if(visible(item.note))node.append(rich('p',item.note));if(i&&b.layout!=='timeline')grid.append(text('span','→','learning-arrow'));grid.append(node);}section.append(grid);break;}
    case 'compare':{const grid=document.createElement('div');grid.className='learning-compare-grid';for(const item of list(b.columns,3)){const col=document.createElement('div');col.append(rich('h4',item.title));body(col,item.body);grid.append(col);}section.append(grid);break;}
    case 'result':{const grid=document.createElement('div');grid.className='learning-result-grid';for(const item of list(b.items,3)){const node=document.createElement('div');node.append(rich('small',item.label),rich('strong',item.value));if(visible(item.note))node.append(rich('p',item.note));grid.append(node);}section.append(grid);if(b.conclusion)body(section,b.conclusion);break;}
    case 'derivation':for(const [i,item]of list(b.steps,12).entries()){const row=document.createElement('div');row.className='learning-step';const formula=document.createElement('div');formula.className='learning-expression';formula.append(renderMath(item.expression,{display:true}));row.append(text('small',String(i+1).padStart(2,'0')),formula);if(visible(item.reason))row.append(rich('p',item.reason));section.append(row);}break;
    case 'callout':if(b.tone==='warning')section.classList.add('learning-warning');section.append(rich('h4',b.title));body(section,b.text);break;
    case 'reveal':case 'term':{const details=document.createElement('details');details.append(rich('summary',b.type==='term'?b.term:b.title));body(details,b.type==='term'?b.definition:b.text);if(visible(b.before))section.append(rich('span',b.before,'learning-term-before'));section.append(details);if(visible(b.after))section.append(rich('span',b.after,'learning-term-after'));break;}
    case 'fill':{const form=document.createElement('form');form.className='learning-fill-form';const label=rich('label',b.label);const input=document.createElement(b.multiline?'textarea':'input');if(!b.multiline)input.type='text';input.maxLength=2000;input.autocomplete='off';input.spellcheck=false;input.placeholder=b.placeholder||'填写你的答案';input.setAttribute('aria-label',plain(b.label));input.value=getDraft(b);const button=text('button','提交回答','learning-submit');button.type='submit';const status=text('p','','learning-reply-status');label.append(input);form.append(label,button);form.onsubmit=e=>{e.preventDefault();if(!isAvailable(b)||!input.value.trim()||input.value.length>2000)return;onStatus('正在发送回答…');onReply(b,input.value.trim());};input.oninput=()=>{onDraft(b,input.value);refresh();};section.append(form,status);controls.push({button,input,block:b,status});break;}
    case 'choices':{const status=text('p','','learning-reply-status');for(const option of list(b.options,6)){const button=rich('button',option.label,'learning-choice');button.type='button';button.title=replyText(b,option);button.setAttribute('aria-label',plain(option.label)+'；发送：'+plain(replyText(b,option)));button.onclick=()=>{if(!isAvailable(b))return;onStatus('正在发送回答…');onReply(b,option);};section.append(button);controls.push({button,block:b,option,status});}section.append(status);break;}
    default:throw Error('不支持的块类型');
  }
  if(b.source&&/^summon-file:[^\r\n]+#L[1-9][0-9]*$/.test(b.source.url)){const source=text('button','查看来源 · '+b.source.label,'learning-source');source.type='button';source.dataset.learningSource=b.source.url;section.append(source);}
  appendSources(section,notes);
  return section;
}
// 单个块不可用时只让这一块退回可读文字：同一条消息里的其他图解和提问继续显示。
function blockFallback(b,error){
  const message=String(b?.fallbackText||'').trim()||'此内容暂不支持，继续阅读正文。';
  return text('p',error?.message&&/无效学习列表/.test(error.message)?`${message}（${error.message}）`:message,'learning-block-fallback');
}
// 正文里可能出现 [^1] 这类脚注标记：正文渲染负责建立编号，这里负责把它列出来，
// 否则标记会在正文里原样显示成 [^1]。
function appendSources(section,notes){
  if(!notes?.size)return false;
  const list=document.createElement('section');list.className='markdown-sources';list.setAttribute('aria-label','引用来源');
  const heading=document.createElement('h4');heading.textContent='引用来源';const ordered=document.createElement('ol');
  for(const note of notes.values()){
    const item=document.createElement('li');item.id=note.target;item.tabIndex=-1;
    if(note.fragment)item.append(note.fragment);else renderMarkdown(item,note.body,{taskIndex:{value:0}});
    ordered.append(item);
  }
  list.append(heading,ordered);section.append(list);
  return true;
}
const envelopeFallback=spec=>String(spec?.fallbackText||'').trim();
const parse=(spec,render)=>{
  if(!isLearningSpec(spec))throw Error('无效学习内容');
  const root=document.createElement('div');root.className='learning-blocks';
  const fallbacks=[];
  for(const b of spec.blocks){try{root.append(render(b));}catch(error){const node=blockFallback(b,error);fallbacks.push(node);root.append(node);}}
  // 每一块都失效、且块与整条消息用同一段降级文字时，作者的意思是整条消息退成文字：
  // 这时不再拼装空壳，交给调用方显示 envelope fallbackText。
  if(fallbacks.length&&fallbacks.length===spec.blocks.length&&envelopeFallback(spec)&&fallbacks.every(node=>node.textContent.startsWith(envelopeFallback(spec))))throw Error(envelopeFallback(spec));
  return root;
};
// 容器空间记录：宽度不足时切到紧凑布局（流程竖排、对比/结果单列），
// 让长公式与多列内容换行，而不是把卡片压到溢出。
const COMPACT_WIDTH=430;
function trackWidth(root){
  if(typeof ResizeObserver!=='function')return;
  const apply=width=>root.classList.toggle('is-compact',width>0&&width<COMPACT_WIDTH);
  try{
    const observer=new ResizeObserver(entries=>{for(const entry of entries)apply(entry.contentRect.width);});
    observer.observe(root);
    apply(root.getBoundingClientRect().width||root.clientWidth||0);
  }catch{/* 环境不支持时保持默认布局 */}
}
// 把工具回执渲染成正文组件；任何一步失败都退回可读文字，不抛出到调用方。
export function createLearningView(spec,{onReply=()=>{},onStatus=()=>{},isAvailable=()=>false,getReplyState=()=>null,getDraft=()=>'',onDraft=()=>{},unavailableText='当前不可回答；可通过输入框继续交流。'}={}){
  const controls=[];
  let root;
  try{root=parse(spec,b=>blockView(b,{getReplyState,getDraft,onDraft,onReply,onStatus,isAvailable,controls,refresh:()=>update()}));}
  catch{root=document.createElement('div');root.className='learning-blocks';root.append(text('p',spec?.fallbackText||'学习内容暂时无法显示，请继续阅读正文。','learning-fallback'));controls.length=0;}
  const update=()=>{for(const c of controls){
    const state=getReplyState(c.block);const answered=state?.status==='answered',sending=state?.status==='sending';
    c.button.disabled=!isAvailable(c.block)||answered||sending||(c.input&&!c.input.value.trim());
    if(c.input){c.input.disabled=answered||sending;if(answered)c.input.value=state.answer||'';c.button.textContent=sending?'正在提交…':answered?'已提交':'提交回答';}
    if(c.option){const selected=answered&&state.optionId===c.option.id;c.button.classList.toggle('is-selected',selected);c.button.setAttribute('aria-pressed',String(selected));}
    c.status.textContent=answered?'已发送你的回答：'+state.answer:sending?'正在发送回答…':state?.status==='error'?'发送失败，可重试。'+(state.message?' '+String(state.message).slice(0,250):''):!isAvailable(c.block)?unavailableText:'提交后作为用户消息发送；输入框草稿会保留。';
  }};
  update();trackWidth(root);return {root,update,setStatus:(value)=>{for(const c of controls){c.status.textContent=String(value);c.button.disabled=true;if(c.input)c.input.disabled=true;}}};
}
// 兼容旧调用点：只需要一个已渲染的正文根节点。
export function renderLearning(spec,options={}){return createLearningView(spec,options);}
