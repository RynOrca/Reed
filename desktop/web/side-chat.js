import {icon} from './icons.js';
import {renderMarkdown} from './markdown.js';

export function createSideChatPanel({tauri,readingContext}){
  const shell=document.querySelector('.chat-shell');
  const entry=document.createElement('button');entry.id='side-chat-button';entry.type='button';entry.className='icon-button';entry.setAttribute('aria-label','侧边聊天');entry.setAttribute('aria-expanded','false');entry.append(icon('chat'));
  document.getElementById('activity-button').before(entry);
  const pane=document.createElement('aside');pane.className='side-chat-pane';pane.hidden=true;pane.setAttribute('aria-label','临时侧边聊天');
  pane.innerHTML='<header><div><strong>侧边聊天</strong><small>参考当前主对话 · 关闭即清除</small></div><button type="button" class="icon-button" data-side="close" aria-label="关闭侧边聊天"></button></header><div class="side-chat-messages" data-side="messages" aria-live="polite"><p class="side-chat-intro">结合主对话继续提问，主对话可以同时回复。<br>仅可读取文件，不会保存聊天记录。</p></div><form><textarea rows="3" aria-label="侧边消息" placeholder="问点什么…" maxlength="20000"></textarea><footer><span data-side="status" role="status">使用主对话当前模型</span><button type="button" data-side="stop" hidden>停止</button><button type="submit" data-side="send">发送</button></footer></form>';
  shell.append(pane);const q=name=>pane.querySelector(`[data-side="${name}"]`),input=pane.querySelector('textarea'),list=q('messages');q('close').append(icon('close'));
  let opened=false,busy=false,requestId=null,answer=null,source='';
  const send=(type,data={})=>tauri.core.invoke('agent_command',{command:{type,...data}});
  function setBusy(value){busy=value;q('send').disabled=value||!input.value.trim();q('stop').hidden=!value;input.disabled=value;}
  function clear(){requestId=null;answer=null;source='';input.value='';list.replaceChildren();setBusy(false);q('status').textContent='使用主对话当前模型';}
  function close(){const wasOpen=opened;opened=false;pane.hidden=true;shell.classList.remove('side-chat-open');entry.setAttribute('aria-expanded','false');clear();if(wasOpen)void send('side_chat_reset').catch(console.error);}
  function availability(){shell.classList.toggle('side-chat-overlay',shell.getBoundingClientRect().width<760);entry.title='侧边临时聊天';}
  entry.onclick=()=>{if(opened){close();return;}if(entry.disabled)return;clear();opened=true;pane.hidden=false;shell.classList.add('side-chat-open');entry.setAttribute('aria-expanded','true');void send('side_chat_reset').catch(error=>{q('status').textContent=String(error.message||error);});input.focus();};
  q('close').onclick=close;q('stop').onclick=()=>{q('status').textContent='正在停止…';void send('side_chat_abort').catch(error=>{q('status').textContent=String(error.message||error);});};
  input.addEventListener('input',()=>setBusy(busy));
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();pane.querySelector('form').requestSubmit();}});
  pane.querySelector('form').onsubmit=event=>{
    event.preventDefault();if(busy||!input.value.trim())return;
    const text=input.value.trim(),row=document.createElement('div');row.className='side-chat-user';row.textContent=text;list.append(row);
    answer=document.createElement('div');answer.className='side-chat-answer prose-chat';list.append(answer);source='';requestId='side-'+crypto.randomUUID();input.value='';setBusy(true);q('status').textContent='正在回复…';list.scrollTop=list.scrollHeight;
    const id=requestId;void send('side_chat_prompt',{id,text,readingContext:readingContext?.snapshot()}).catch(error=>{if(requestId!==id)return;setBusy(false);q('status').textContent=String(error.message||error);});
  };
  new ResizeObserver(availability).observe(shell);availability();setBusy(false);
  return {event(event){
    if(!opened||event.id!==requestId)return;
    if(event.state==='delta'){source+=event.text||'';renderMarkdown(answer,source);q('status').textContent='正在回复…';list.scrollTop=list.scrollHeight;}
    if(event.state==='text'){source=event.text||'';renderMarkdown(answer,source);list.scrollTop=list.scrollHeight;}
    if(event.state==='reading')q('status').textContent='正在读取：'+event.path;
    if(event.state==='done'||event.state==='error'||event.state==='cancelled'){setBusy(false);q('status').textContent=event.message||(event.state==='done'?'回复完成':'已停止');if(pane.contains(document.activeElement))input.focus();}
  },close};
}
