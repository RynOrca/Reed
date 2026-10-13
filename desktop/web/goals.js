import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { goalTasks } from "./goal-tasks.js";

export function createGoals({ command }) {
  const body=document.querySelector(".chat-body"),shell=document.querySelector(".chat-shell");
  const slot=document.createElement("div");slot.className="goals-slot";
  slot.innerHTML=`<aside class="goals-drawer" aria-label="学习目标" inert><header class="goals-header"><h2>学习目标</h2><div><button type="button" data-goal="edit">编辑</button><button type="button" class="icon-button" data-goal="close" aria-label="收起学习目标"></button></div></header><div class="goals-read"><div class="goals-progress-label"><span>进度</span><span data-goal="count"></span></div><div class="goals-progress"><div></div></div><article class="goals-document prose-chat"></article></div><div class="goals-edit" hidden><textarea aria-label="学习目标 Markdown" spellcheck="false"></textarea><div><button type="button" data-goal="cancel">取消</button><button type="button" data-goal="save-edit">保存目标</button></div></div><footer class="goals-footer"><div class="goals-save"><span data-goal="save-state"></span><button type="button" data-goal="save" hidden>保存</button></div><span data-goal="project"></span><small data-goal="path"></small></footer><div class="goals-error" role="alert" hidden></div><button type="button" class="goals-reload" data-goal="reload" hidden>重新加载文件</button><div class="goals-notice" hidden><h3>还有未保存的修改</h3><p>保存后，这个项目的对话就能读取新的学习目标。</p><div><button type="button" data-goal="keep">继续编辑</button><button type="button" data-goal="discard">放弃修改</button><button type="button" data-goal="save-close">保存并关闭</button></div></div></aside>`;
  const button=document.createElement("button");button.type="button";button.className="goals-handle";button.title="学习目标";button.setAttribute("aria-label","打开学习目标");button.setAttribute("aria-expanded","false");button.append(icon("book"));button.hidden=true;slot.hidden=true;
  const veil=document.createElement("div");veil.className="goals-veil";veil.hidden=true;
  body.append(button);shell.append(veil,slot);shell.classList.add("goals-closed");
  const q=s=>slot.querySelector(s),el=name=>q(`[data-goal="${name}"]`);
  el("close").append(icon("close"));const heading=q("h2");heading.prepend(icon("book"));
  const editor=q("textarea"),doc=q("article"),drawer=q("aside"),error=q(".goals-error"),notice=q(".goals-notice");
  let project=null,goal=null,draft="",editing=false,loading=0,saving=false,closeAfter=false,enabled=false;
  const drafts=new Map();
  const current=()=>editing?editor.value:draft;
  const dirty=()=>!!goal&&current()!==goal.body;
  function report(message=""){error.textContent=message;error.hidden=!message;el("reload").hidden=!message;}
  function state(){el("save-state").textContent=saving?"保存中…":dirty()?"未保存":"";el("save").hidden=!dirty()||editing;el("save").disabled=saving;el("save-edit").disabled=saving||!dirty();editor.disabled=saving;el("edit").disabled=saving||!goal;}
  function render(){
    const tasks=goalTasks(draft),done=tasks.filter(t=>t.checked).length;
    el("count").textContent=tasks.length?`${done} / ${tasks.length} 已完成`:"尚无小目标";
    q(".goals-progress div").style.width=tasks.length?`${done/tasks.length*100}%`:"0%";
    renderMarkdown(doc,draft||"# 学习目标\n\n点击右上角编辑，用 Markdown 写下大目标、阶段和小目标。",{onTask:(index,checked)=>{if(saving)return;const task=goalTasks(draft)[index];if(!task){report("目标格式已变化，请使用 Markdown 编辑");return;}draft=draft.slice(0,task.offset)+(checked?"x":" ")+draft.slice(task.offset+1);render();state();}});
    state();
  }
  function mode(value){editing=value;q(".goals-read").hidden=value;q(".goals-edit").hidden=!value;el("edit").hidden=value;if(value){editor.value=draft;editor.focus();}state();}
  function show(){if(!enabled)return;shell.classList.remove("goals-closed");drawer.inert=false;drawer.setAttribute("aria-hidden","false");button.setAttribute("aria-expanded","true");el("close").focus({preventScroll:true});}
  function hide(){shell.classList.add("goals-closed");drawer.inert=true;drawer.setAttribute("aria-hidden","true");button.setAttribute("aria-expanded","false");notice.hidden=true;if(!button.hidden)button.focus({preventScroll:true});}
  function close(){if(saving)return;if(dirty()){closeAfter=true;notice.hidden=false;el("keep").focus();}else hide();}
  async function save(){if(!enabled||!goal||saving)return false;const target=project,text=current(),ticket=loading;saving=true;state();report();try{
    const result=await command("save_goals",{projectPath:target,body:text,revision:goal.revision},true);
    if(ticket!==loading){drafts.delete(target);return true;}
    goal=result.goal;draft=goal.body;drafts.delete(target);mode(false);render();return true;
  }catch(e){if(ticket===loading)report(e.message);return false;}finally{saving=false;state();}}
  let reloadTimer,confirmReload=false;
  el("reload").onclick=async()=>{
    if(!enabled)return;
    if(dirty()&&!confirmReload){confirmReload=true;el("reload").textContent="确认放弃草稿";el("reload").classList.add("confirm");clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>{confirmReload=false;el("reload").textContent="重新加载文件";el("reload").classList.remove("confirm");},3000);return;}
    confirmReload=false;clearTimeout(reloadTimer);el("reload").textContent="重新加载文件";el("reload").classList.remove("confirm");const ticket=loading;
    try{const result=await command("get_goals",{},true);if(ticket!==loading)return;goal=result.goal;draft=goal?.body||"";drafts.delete(project);mode(false);render();report();}catch(e){report(e.message);}
  };
  button.onclick=()=>{if(!project){document.getElementById("workspace-button").click();return;}show();};veil.onclick=close;el("close").onclick=close;el("edit").onclick=()=>mode(true);editor.oninput=state;
  el("save").onclick=save;el("save-edit").onclick=save;el("cancel").onclick=()=>{if(editor.value!==draft){closeAfter=false;notice.hidden=false;}else mode(false)};
  el("keep").onclick=()=>{notice.hidden=true;(editing?editor:el("edit")).focus();};
  el("discard").onclick=()=>{draft=goal?.body||"";drafts.delete(project);mode(false);render();notice.hidden=true;if(closeAfter)hide();};
  el("save-close").onclick=async()=>{const closeIt=closeAfter;if(await save()){notice.hidden=true;if(closeIt)hide();}};
  document.addEventListener("keydown",e=>{if(shell.classList.contains("goals-closed"))return;if(e.key==="Escape"){e.preventDefault();if(!notice.hidden)notice.hidden=true;else close();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();void save();}});
  window.addEventListener("beforeunload",e=>{if(dirty()||drafts.size){e.preventDefault();e.returnValue="";}});
  return {async session(next,nextEnabled=false){
    if(next===project&&nextEnabled===enabled&&goal)return;
    if(project&&dirty())drafts.set(project,{body:current(),revision:goal.revision});
    enabled=nextEnabled;project=next;goal=null;draft="";editing=false;const ticket=++loading;button.hidden=!enabled;slot.hidden=!enabled;veil.hidden=!enabled;button.title=project?"学习目标":"选择项目后查看学习目标";notice.hidden=true;report();mode(false);render();
    if(!enabled){hide();doc.replaceChildren();editor.value="";el("project").textContent="";el("path").textContent="";el("path").removeAttribute("title");return;}
    if(!project){hide();return;}
    el("project").textContent=next.replace(/[\\/]+$/,"").split(/[\\/]/).pop();el("path").textContent=next;el("path").title=next;
    try{const result=await command("get_goals",{},true);if(ticket!==loading)return;goal=result.goal;if(!goal)return;
      const stash=drafts.get(next);draft=stash?.body??goal.body;
      if(stash && stash.revision!==goal.revision){goal.revision=stash.revision;report("此项目还有未保存草稿，原文件也已更新。请复制草稿后重新打开目标，再合并修改。");}
      render();
    }catch(e){if(ticket===loading)report(e.message);}
  }};
}
