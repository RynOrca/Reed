import {icon} from './icons.js';

export function createProjectPicker({button,command,tauri,isRunning,onError,onSelect}){
  const popup=document.createElement('section');popup.className='project-picker';popup.hidden=true;popup.setAttribute('aria-label','选择项目');
  popup.innerHTML='<header>最近项目</header><div class="project-picker-list" role="menu"></div><div class="project-picker-status" role="status" hidden></div><footer><button type="button" role="menuitem"><span></span>新建/选择项目文件夹…</button></footer>';
  document.body.append(popup);const list=popup.querySelector('.project-picker-list'),status=popup.querySelector('[role=status]'),create=popup.querySelector('footer button');create.querySelector('span').append(icon('new'));
  button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');let sessions=[],loading=false,epoch=0;
  function close({focus=false}={}){epoch++;popup.hidden=true;button.setAttribute('aria-expanded','false');if(focus)button.focus();}
  function position(){if(popup.hidden)return;const anchor=button.getBoundingClientRect();popup.style.width=Math.min(360,innerWidth-24)+'px';const rect=popup.getBoundingClientRect();popup.style.left=Math.max(12,Math.min(anchor.left,innerWidth-rect.width-12))+'px';popup.style.top=Math.max(12,anchor.top-rect.height-10)+'px';}
  async function run(work){try{await work();close();onSelect();}catch(error){status.hidden=false;status.textContent=error.message||String(error);position();}}
  function render(){
    list.replaceChildren();const groups=new Map();for(const session of sessions.filter(s=>s.projectPath&&s.messageCount>0)){const key=session.projectPath.replace(/[\\/]+$/,'').replaceAll('\\','/').toLowerCase();const old=groups.get(key);if(!old||(!session.archived&&old.archived)||(session.archived===old.archived&&new Date(session.modified)>new Date(old.modified)))groups.set(key,session);}
    for(const item of [...groups.values()].sort((a,b)=>new Date(b.modified)-new Date(a.modified))){const row=document.createElement('button');row.type='button';row.className='project-picker-item';row.setAttribute('role','menuitem');row.title=item.projectPath;const copy=document.createElement('span'),name=document.createElement('strong'),path=document.createElement('small');name.textContent=item.projectPath.split(/[\\/]/).filter(Boolean).pop();path.textContent=item.projectPath;copy.append(name,path);row.append(icon('folder'),copy);row.onclick=()=>run(()=>command('open_session',{sessionId:item.id},true));list.append(row);}
    if(!list.childElementCount){const empty=document.createElement('p');empty.className='project-picker-empty';empty.textContent=loading?'正在读取项目…':'还没有项目对话记录';list.append(empty);}position();
  }
  create.onclick=()=>run(async()=>{const path=await tauri.core.invoke('choose_workspace');if(path)await command('change_workspace',{path},true);});
  button.addEventListener('click',async()=>{if(!popup.hidden){close();return;}popup.hidden=false;button.setAttribute('aria-expanded','true');loading=true;status.hidden=true;render();const ticket=++epoch;try{const result=await command('list_sessions',{},true);if(ticket!==epoch)return;sessions=result.sessions||[];loading=false;render();(list.querySelector('button')||create).focus();}catch(error){if(ticket!==epoch)return;loading=false;status.hidden=false;status.textContent=error.message||String(error);render();}});
  popup.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close({focus:true});}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const items=[...popup.querySelectorAll('button')],index=items.indexOf(document.activeElement);items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}});
  document.addEventListener('pointerdown',e=>{if(!popup.hidden&&!popup.contains(e.target)&&!button.contains(e.target))close();});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!popup.hidden)close({focus:true});});window.addEventListener('resize',position);
  return {close,update(next){sessions=next||[];if(!popup.hidden)render();}};
}
