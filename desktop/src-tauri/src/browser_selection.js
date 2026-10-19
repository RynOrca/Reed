(()=>{
  if(window.top!==window)return;
  let bar,quote;
  const hide=()=>{if(bar){bar.hidden=true;bar.style.display='none';}};
  document.addEventListener('selectionchange',()=>{if(!getSelection()?.toString().trim())hide();});
  document.addEventListener('mouseup',event=>{
    if(bar?.contains(event.target))return;
    const selection=getSelection(),text=selection?.toString().trim();
    if(!text||text.length>4000||!selection.rangeCount){hide();return;}
    const range=selection.getRangeAt(0),rect=range.getBoundingClientRect();
    quote={text,context:(range.commonAncestorContainer.parentElement?.innerText||text).slice(0,1500),title:document.title,url:location.href};
    if(!bar){
      bar=document.createElement('div');bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','选中文字操作');
      bar.style.cssText='position:fixed;z-index:2147483647;display:flex;gap:2px;padding:4px;background:#242920;color:#f4f1e8;border:1px solid #74836a;border-radius:8px;box-shadow:0 4px 18px #0003;font:13px system-ui;';
      for(const [action,label] of [['quote','加入对话'],['explain','解释'],['ask','追问']]){
        const button=document.createElement('button');button.textContent=label;button.type='button';button.style.cssText='border:0;background:transparent;color:inherit;padding:6px 9px;cursor:pointer;font:inherit;';
        button.onmousedown=e=>e.preventDefault();button.onclick=()=>{
          const query=new URLSearchParams({...quote,action});hide();location.href='reed-selection://quote?'+query;
        };bar.append(button);
      }
      document.documentElement.append(bar);
    }
    bar.hidden=false;bar.style.display='flex';bar.style.left=Math.max(6,Math.min(innerWidth-240,rect.left))+'px';bar.style.top=Math.max(6,Math.min(innerHeight-48,rect.bottom+8))+'px';
  });
  addEventListener('scroll',hide,{passive:true});
  document.addEventListener('click',event=>{const link=event.target.closest?.('a[target="_blank"]');if(link&&/^https?:/i.test(link.href)){event.preventDefault();location.href=link.href;}});
})();
