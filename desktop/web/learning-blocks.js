import {renderMarkdown} from './markdown.js';
import {renderMath} from './math.js';
const text=(tag,value,cls='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=String(value||'').slice(0,6000);return n;};
export const replyText=(block,answer)=>block.type==='fill'?`关于「${block.title}」：\n${block.label} ${answer.trim()}`:`关于「${block.title}」：${answer.replyText}`;
export function renderLearning(spec,{onReply=()=>{},isAvailable=()=>false,getReplyState=()=>null,getDraft=()=>'',onDraft=()=>{}}={}){
  const root=document.createElement('div');root.className='learning-blocks';
  const controls=[];
  try{
    if(spec?.schemaVersion!==1||!Array.isArray(spec.blocks)||!spec.blocks.length||spec.blocks.length>8)throw Error('无效学习内容');
    for(const b of spec.blocks){
      const section=document.createElement('section');section.className='learning-block learning-'+b.type;section.dataset.blockId=b.id;
      const body=(host,value)=>{const n=document.createElement('div');renderMarkdown(n,String(value||'').slice(0,2400));host.append(n);};
      const list=(values,max)=>{if(!Array.isArray(values)||!values.length||values.length>max)throw Error('无效学习列表');return values;};
      if(b.title&&!['reveal','callout'].includes(b.type))section.append(text('h3',b.title));
      switch(b.type){
        case 'flow':{const grid=document.createElement('div');grid.className=b.layout==='timeline'?'learning-timeline':'learning-path';for(const [i,item]of list(b.nodes,6).entries()){const node=document.createElement('div');node.className='learning-node';node.append(text('small',item.label),text('strong',item.value),text('p',item.note));if(i&&b.layout!=='timeline')grid.append(text('span','→','learning-arrow'));grid.append(node);}section.append(grid);break;}
        case 'compare':{const grid=document.createElement('div');grid.className='learning-compare-grid';for(const item of list(b.columns,3)){const col=document.createElement('div');col.append(text('h4',item.title));body(col,item.body);grid.append(col);}section.append(grid);break;}
        case 'result':{const grid=document.createElement('div');grid.className='learning-result-grid';for(const item of list(b.items,3)){const node=document.createElement('div');node.append(text('small',item.label),text('strong',item.value),text('p',item.note));grid.append(node);}section.append(grid);if(b.conclusion)body(section,b.conclusion);break;}
        case 'derivation':for(const [i,item]of list(b.steps,12).entries()){const row=document.createElement('div');row.className='learning-step';row.append(text('small',String(i+1).padStart(2,'0')),(()=>{const formula=document.createElement('div');formula.className='learning-expression';formula.append(renderMath(item.expression,{display:true}));return formula;})(),text('p',item.reason));section.append(row);}break;
        case 'callout':if(b.tone==='warning')section.classList.add('learning-warning');section.append(text('h4',b.title));body(section,b.text);break;
        case 'reveal':case 'term':{const details=document.createElement('details');details.append(text('summary',b.type==='term'?b.term:b.title));body(details,b.type==='term'?b.definition:b.text);if(b.before)section.append(text('span',b.before));section.append(details);if(b.after)section.append(text('span',b.after));break;}
        case 'fill':{const form=document.createElement('form');form.className='learning-fill-form';const label=text('label',b.label);const input=document.createElement(b.multiline?'textarea':'input');if(!b.multiline)input.type='text';input.maxLength=2000;input.autocomplete='off';input.spellcheck=false;input.placeholder=b.placeholder||'填写你的答案';input.setAttribute('aria-label',b.label);input.value=getDraft(b);const button=text('button','提交回答','learning-submit');button.type='submit';const status=text('p','','learning-reply-status');label.append(input);form.append(label,button);form.onsubmit=e=>{e.preventDefault();if(!isAvailable(b)||!input.value.trim()||input.value.length>2000)return;onReply(b,input.value.trim());};input.oninput=()=>{onDraft(b,input.value);update();};section.append(form,status);controls.push({button,input,block:b,status});break;}
        case 'choices':{const status=text('p','','learning-reply-status');for(const option of list(b.options,6)){const button=text('button',option.label,'learning-choice');button.type='button';button.title=replyText(b,option);button.setAttribute('aria-label',option.label+'；发送：'+replyText(b,option));button.onclick=()=>{if(!isAvailable(b))return;onReply(b,option);};section.append(button);controls.push({button,block:b,option,status});}section.append(status);break;}
        default:section.replaceChildren(text('p',b.fallbackText||'此内容暂不支持，继续阅读正文。'));break;
      }
      if(b.source&&/^summon-file:[^\r\n]+#L[1-9][0-9]*$/.test(b.source.url)){const source=text('button','查看来源 · '+b.source.label,'learning-source');source.type='button';source.dataset.learningSource=b.source.url;section.append(source);}
      root.append(section);
    }
  }catch{root.replaceChildren(text('p',spec?.fallbackText||'学习内容暂时无法显示，请继续阅读正文。','learning-fallback'));controls.length=0;}
  const update=()=>{for(const c of controls){
    const state=getReplyState(c.block);const answered=state?.status==='answered',sending=state?.status==='sending';
    c.button.disabled=!isAvailable(c.block)||answered||sending||(c.input&&!c.input.value.trim());
    if(c.input){c.input.disabled=answered||sending;if(answered)c.input.value=state.answer||'';c.button.textContent=sending?'正在提交…':answered?'已提交':'提交回答';}
    if(c.option){const selected=answered&&state.optionId===c.option.id;c.button.classList.toggle('is-selected',selected);c.button.setAttribute('aria-pressed',String(selected));}
    c.status.textContent=answered?'已发送你的回答：'+state.answer:sending?'正在发送回答…':state?.status==='error'?'发送失败，可重试。'+(state.message?' '+String(state.message).slice(0,250):''):!isAvailable(c.block)?'当前不可回答；可通过输入框继续交流。':'提交后作为用户消息发送；输入框草稿会保留。';
  }};
  update();return {root,update};
}
