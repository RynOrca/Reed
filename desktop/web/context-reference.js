import {icon as baseIcon} from './icons.js';
const icon=name=>{const svg=baseIcon(name);svg.classList.add('icon');return svg;};

const groups=[['pdf','教材'],['note','笔记'],['background','学习背景'],['work','工作经验'],['other','其他']];
const groupOf=kind=>kind==='pdf'?'pdf':kind==='note'?'note':['goal','memory','preference'].includes(kind)?'background':kind==='work'?'work':'other';
const kindName={pdf:'教材',note:'笔记',goal:'学习目标',memory:'相关记忆',preference:'教学偏好',work:'工作经验',status:'参考状态'};

export function referenceIdentity(item){
  const raw=String(item.location||item.label||item.kind||'参考来源');
  if(item.kind==='note'){
    const location=String(item.location||item.label||'').replaceAll('\\','/'),parts=location.split('/').filter(Boolean),leaf=parts.pop()||'笔记';
    const label=String(item.label||'');
    return {title:(label&&!/[\\/]/.test(label)?label:leaf).replace(/\.md$/i,''),parent:parts.slice(-2).join(' / ')||'笔记',location};
  }
  return {title:String(item.label||kindName[item.kind]||'参考来源'),parent:item.pinned?'当前项目 · 每轮读取':kindName[item.kind]||'参考资料',location:item.location||item.url||raw};
}

let detail;
function showSource(item){
  if(!detail){
    detail=document.createElement('dialog');detail.className='context-source-dialog';detail.setAttribute('aria-label','参考来源详情');
    detail.innerHTML='<header><div><h2></h2><p data-source="parent"></p></div><button type="button" aria-label="关闭来源详情"></button></header><section><div data-source="excerpt-wrap"><h3>参考片段</h3><p data-source="excerpt"></p><small data-source="truncated" hidden>此处仅展示片段，不代表完整来源。</small></div><h3>来源位置</h3><p data-source="location"></p><small data-source="usage"></small></section>';
    const close=detail.querySelector('button');close.append(icon('close'));close.onclick=()=>detail.close();document.body.append(detail);
  }
  const identity=referenceIdentity(item),q=name=>detail.querySelector(`[data-source="${name}"]`);
  detail.querySelector('h2').textContent=identity.title;q('parent').textContent=identity.parent;
  q('excerpt-wrap').hidden=!item.excerpt;q('excerpt').textContent=item.excerpt||'';q('truncated').hidden=!item.excerptTruncated;
  q('location').textContent=identity.location;q('usage').textContent=Number.isFinite(item.tokens)?`约 ${item.tokens.toLocaleString()} tokens · 文本估算`:kindName[item.kind]||'参考资料';
  if(!detail.open)detail.showModal();
}

export function renderContextReference(root,report){
  const items=Array.isArray(report.items)?report.items:[],wasOpen=root.open,selected=root.dataset.sourceGroup;
  root.className='context-reference-report ref-disclosure';root.hidden=items.length===0;root.replaceChildren();
  const summary=document.createElement('summary'),label=document.createElement('span'),count=document.createElement('span'),chevron=icon('chevron');
  label.textContent='本轮参考';count.textContent=`${items.length} 项`;count.className='ref-count';chevron.classList.add('ref-chevron');summary.append(icon('activity'),label,count,chevron);root.append(summary);
  const panel=document.createElement('section');panel.className='ref-panel';panel.setAttribute('aria-label','本轮参考来源');
  const tabs=document.createElement('div');tabs.className='ref-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','来源类型');
  const list=document.createElement('div');list.className='ref-source-list';list.setAttribute('role','tabpanel');
  const available=groups.filter(([key])=>items.some(item=>groupOf(item.kind)===key));
  const choose=key=>{
    root.dataset.sourceGroup=key;for(const tab of tabs.children){const active=tab.dataset.key===key;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
    list.replaceChildren();list.setAttribute('aria-label',groups.find(g=>g[0]===key)?.[1]||'来源');
    for(const item of items.filter(item=>groupOf(item.kind)===key)){
      const identity=referenceIdentity(item),button=document.createElement('button'),copy=document.createElement('span'),title=document.createElement('span'),parent=document.createElement('span'),arrow=icon('chevron');
      button.type='button';button.className='ref-source';button.setAttribute('aria-label',`查看参考：${identity.title}`);copy.className='ref-source-copy';title.className='ref-source-title';title.textContent=identity.title;parent.className='ref-source-parent';parent.textContent=identity.parent;copy.append(title,parent);arrow.classList.add('ref-row-chevron');button.append(icon(item.kind==='pdf'?'book':key==='background'?'info':'activity'),copy,arrow);button.onclick=()=>showSource(item);list.append(button);
    }
  };
  for(const [key,title]of available){
    const tab=document.createElement('button'),number=document.createElement('span');tab.type='button';tab.dataset.key=key;tab.setAttribute('role','tab');tab.append(document.createTextNode(title+' '));number.className='ref-tab-count';number.textContent=items.filter(item=>groupOf(item.kind)===key).length;tab.append(number);tab.onclick=()=>choose(key);
    tab.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=available.findIndex(g=>g[0]===root.dataset.sourceGroup),next=event.key==='Home'?0:event.key==='End'?available.length-1:(index+(event.key==='ArrowRight'?1:-1)+available.length)%available.length;choose(available[next][0]);tabs.children[next].focus();};tabs.append(tab);
  }
  const foot=document.createElement('footer'),usage=document.createElement('details'),usageTitle=document.createElement('summary'),usageValue=document.createElement('p');foot.className='ref-foot';usageTitle.append(document.createTextNode('上下文用量'),icon('chevron'));usageValue.textContent=`约 ${Math.max(0,Number(report.referenceTokens)||0).toLocaleString()} tokens · 文本估算`;
  if(items.some(item=>item.pinned))usageValue.textContent+='；包含每轮读取的项目目标。';
  usage.append(usageTitle,usageValue);foot.append(usage);panel.append(tabs,list,foot);root.append(panel);if(available.length)choose(available.some(g=>g[0]===selected)?selected:available[0][0]);root.open=wasOpen;
}
