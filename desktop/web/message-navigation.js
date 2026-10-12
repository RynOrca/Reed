export function createMessageNavigation({messages,transcript,onNavigate}) {
  const rail=document.createElement("nav");rail.className="message-navigation";rail.setAttribute("aria-label","跳转到用户消息");transcript.parentElement.append(rail);
  let rows=[],buttons=[],scheduled=false;
  function refresh(){
    scheduled=false;const next=[...messages.querySelectorAll(".message-row.user")];
    if(next.length!==rows.length||next.some((row,i)=>row!==rows[i])) {
      rows=next;buttons=rows.map((row,index)=>{const b=document.createElement("button");b.type="button";b.className="message-jump";b.append(document.createElement("span"));b.onclick=()=>{onNavigate();const top=row.getBoundingClientRect().top-transcript.getBoundingClientRect().top+transcript.scrollTop-18;transcript.scrollTo({top,behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth"});};return b;});rail.replaceChildren(...buttons);
    }
    rail.hidden=!rows.length;
    const top=transcript.getBoundingClientRect().top+36;let active=0;
    rows.forEach((row,i)=>{const text=row.querySelector(".message-user-text")?.textContent?.trim()||"图片或文件附件";buttons[i].title=`${i+1}. ${text.slice(0,100)}`;buttons[i].setAttribute("aria-label",`跳转到第 ${i+1} 条用户消息：${text.slice(0,70)}`);if(row.getBoundingClientRect().top<=top)active=i;});
    buttons.forEach((b,i)=>{const selected=i===active;b.classList.toggle("active",selected);if(selected)b.setAttribute("aria-current","true");else b.removeAttribute("aria-current");});
  }
  function schedule(){if(!scheduled){scheduled=true;requestAnimationFrame(refresh);}}
  new MutationObserver(schedule).observe(messages,{childList:true,subtree:true,characterData:true});
  new ResizeObserver(schedule).observe(transcript);transcript.addEventListener("scroll",schedule,{passive:true});schedule();
}
