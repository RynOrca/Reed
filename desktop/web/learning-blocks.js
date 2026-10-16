import {renderMarkdown} from './markdown.js';
const text=(tag,value,cls='')=>{const n=document.createElement(tag);n.className=cls;n.textContent=String(value||'').slice(0,6000);return n;};
export const replyText=(block,option)=>`关于「${block.title}」：${option.replyText}`;
export function renderLearning(spec,{onReply=()=>{},isAvailable=()=>false}={}){
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
        case 'derivation':for(const [i,item]of list(b.steps,12).entries()){const row=document.createElement('div');row.className='learning-step';row.append(text('small',String(i+1).padStart(2,'0')),text('div',item.expression,'learning-expression'),text('p',item.reason));section.append(row);}break;
        case 'callout':if(b.tone==='warning')section.classList.add('learning-warning');section.append(text('h4',b.title));body(section,b.text);break;
        case 'reveal':case 'term':{const details=document.createElement('details');details.append(text('summary',b.type==='term'?b.term:b.title));body(details,b.type==='term'?b.definition:b.text);if(b.before)section.append(text('span',b.before));section.append(details);if(b.after)section.append(text('span',b.after));break;}
        case 'choices':{const status=text('p','','learning-reply-status');for(const option of list(b.options,6)){const button=text('button',option.label,'learning-choice');button.type='button';button.title=replyText(b,option);button.setAttribute('aria-label',option.label+'；发送：'+replyText(b,option));button.onclick=()=>{if(!isAvailable(b))return;onReply(b,option);};section.append(button);controls.push({button,block:b,option,status});}section.append(status);break;}
        default:section.replaceChildren(text('p',b.fallbackText||'此内容暂不支持，继续阅读正文。'));break;
      }
      root.append(section);
    }
  }catch{root.replaceChildren(text('p',spec?.fallbackText||'学习内容暂时无法显示，请继续阅读正文。','learning-fallback'));controls.length=0;}
  const update=()=>{for(const c of controls){c.button.disabled=!isAvailable(c.block);c.status.textContent=c.button.disabled?'当前不可回答；可通过输入框继续交流。':'点击即发送对应用户消息，输入框草稿会保留。';}};
  update();return {root,update};
}
