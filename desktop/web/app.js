import {renderLearning,replyText} from './learning-blocks.js';
import {createLearningMode} from './learning-mode.js';
// Transcript row structure and disclosure behavior adapted from PI-Desktop 0.16.1.
import {createGoals} from "./goals.js";
import {createConversationCanvas} from "./conversation-canvas.js";
import {createProjectPicker} from "./project-picker.js";
import {createMessageNavigation} from "./message-navigation.js";
import {renderMarkdown} from "./markdown.js";
import {renderAssistantMarkdown,recoveredQuestionKey,saveRecoveredAnswer,loadRecoveredAnswers} from "./learning-literals.js";
import { icon, windowHandles } from "./icons.js";
import { retryStarted, retryEnded, turnStillRunning, terminalErrorMessage } from "./turn-state.mjs";
const $ = (id) => document.getElementById(id);
import { createSkillBindings } from "./role-skills.js";
const roleLearningMode=createLearningMode(document.getElementById('role-learning-mode'),{onChange:async(features)=>{if(!editingRoleId)return false;await command('set_role_learning',{roleId:editingRoleId,...features},true);return true;}});
const roleSkills = createSkillBindings($("role-skills"));
import { initBrand, finishStartup } from "./brand.js";
const tauri = window.__TAURI__;
await initBrand(tauri);
const messages = $("messages");
const transcript = $("transcript");
const prompt = $("prompt");
const modelsDialog = $("models-dialog");
$("image-close").onclick=()=>$("image-dialog").close();
let modelCatalog = [];
let reconnectAttempts = 0;
let reconnectTimer;
const historyDrawer = $("history-drawer");
const rolesDialog = $("roles-dialog");
let activeRoleId = "agent";
let roles = [];
let editingRoleId = null;
let activeSessionId = "";
let activeSessionName = "";
let sequence = 0;
const commandPrefix=`chat-${crypto.randomUUID()}-`;
let activePromptId=null;
let activeTurnId=null;
let running = false;
let stopping = false;
let recoveryStatus = "";
let retrying = false;
let turnErrorShown = false;
let assistantRow = null;
let thinkingRow = null;
let submitted = null;
const toolRows = new Map();
const learningRows=new Map();
let learningCandidate=null;
const learningStates=new Map();
const learningStateKey=(sessionId,toolCallId,blockId)=>JSON.stringify([sessionId,toolCallId,blockId]);
const learningDraftKey=(sessionId,toolCallId,blockId)=>'reed-learning-draft:'+learningStateKey(sessionId,toolCallId,blockId);
function learningDraft(sessionId,toolCallId,blockId,value){const key=learningDraftKey(sessionId,toolCallId,blockId);try{if(value!==undefined)localStorage.setItem(key,value.slice(0,2000));return localStorage.getItem(key)||'';}catch{return '';}}
// 模型把标记写进正文时，块是从文字里恢复的，没有工具回执。它们同样要能作答：
// 用本地稳定键记录题干与已答状态，作答走普通用户消息，历史重放时恢复状态。
const recoveredAnswerStates=new Map();
// 恢复题目的待确认作答：本轮 done 后据此落定已答状态。
let recoveredPending=null;
const recoveredQuestionTexts=new Map();
const recoveredIndex=()=>{const index={};for(const [key,text] of recoveredQuestionTexts)index[key]={text};return index;};
function updateRecoveredStates(){for(const [key,state] of Object.entries(loadRecoveredAnswers(recoveredIndex())))if(!recoveredAnswerStates.has(key))recoveredAnswerStates.set(key,state);}

function updateLearningAvailability(){for(const entry of learningRows.values()){
  if(!running&&!entry.view&&entry.content.querySelector('.learning-pending'))entry.content.textContent=entry.fallback||'图解未完成，请继续阅读正文或通过输入框追问。';
  entry.view?.update();
}}
const permissionRows = new Map();
const pending = new Map();
const queuedTexts = new Map();
let attachments = [];
let followLatest = true;
const goalsPanel = createGoals({command});
const projectPicker=createProjectPicker({button:$('workspace-button'),command,tauri,isRunning:()=>running,onError:errorRow,onSelect:()=>{closeHistory();prompt.focus();}});
const canvasPanel = createConversationCanvas({command,tauri,prompt,isRunning:()=>running,reportError:errorRow,onUnavailable:()=>{
  const role=roles.find(item=>item.id===activeRoleId);
  if(!role){void command('get_state').catch(roleError);return;}
  openRoleEditor(role);if(!rolesDialog.open)rolesDialog.showModal();
  roleError('请启用此角色的「对话画布」，保存后即可从左侧展开。');
  $('role-canvas-enabled').focus();
},onJump:async(messageId)=>{
  if(running)throw new Error("请等待当前回复结束后定位原文");
  await command("get_history",{},true);
  const row=messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if(!row)throw new Error("当前会话分支中未找到这条原文");
  followLatest=false;row.scrollIntoView({block:"center",behavior:"smooth"});
  row.animate([{backgroundColor:"var(--goal-accent-soft)"},{backgroundColor:"transparent"}],{duration:1600});
}});
createMessageNavigation({messages,transcript,onNavigate:()=>{followLatest=false;}});
transcript.addEventListener("scroll",()=>{followLatest=transcript.scrollHeight-transcript.clientHeight-transcript.scrollTop<65;},{passive:true});

function status(text) {
  $("status").textContent = text;
  $("status").parentElement.classList.toggle("is-busy", /正在|连接/.test(text));
  $("status").parentElement.classList.toggle("is-error", /断开|出错|失败|截断|未生成/.test(text));
}
function updateSendAvailability() { $("send-button").disabled = (!prompt.value.trim() && !attachments.length); }
function scrollToLatest() { if(followLatest)transcript.scrollTop = transcript.scrollHeight; }
// 恢复出来的题目没有工具回执，状态得自己维护：直接改这一段组件里的状态行，
// 不依赖视图注册表（历史重放时注册表会被清空重建）。
function setRecoveredStatus(key,value){
  if(!key)return;
  for(const node of document.querySelectorAll('.learning-blocks[data-recovered-question]')){
    if(node.dataset.recoveredQuestion!==key)continue;
    const line=node.querySelector('.learning-reply-status');
    if(line)line.textContent=value;
    for(const control of node.querySelectorAll('.learning-choice,.learning-submit,input,textarea'))control.disabled=true;
  }
}
// 助手正文统一走这个入口：正常情况就是 Markdown，正文里混进 show_learning 标记时
// 把能识别的部分还原成真实学习块，并让恢复出来的题目可以作答。
function renderAssistant(content, source, messageId){
  return renderAssistantMarkdown(content, source, renderMarkdown, {
    messageId,
    recovered:recoveredAnswerStates,
    canAnswer:()=>!running,
    getRecoveredDraft:(key,block)=>learningDraft('recovered',key,block.id),
    setRecoveredDraft:(key,block,value)=>learningDraft('recovered',key,block.id,value),
    onRecoveredReply:({key,block,question,value})=>{
      const text=replyText(block,value);
      const answer=block.type==='fill'?value.trim():value.replyText;
      recoveredQuestionTexts.set(key,{text,blockTitle:question?.title||''});
      recoveredAnswerStates.set(key,{status:'sending'});
      recoveredPending={key,answer,text,question:question?.title||'',turnId:activeTurnId};
      setRecoveredStatus(key,'正在发送回答…');
      void sendUserMessage(text,{recoveredReply:{key,answer,text,question:question?.title||''}});
    },
  });
}
function refreshEmpty() { $("empty-state").hidden = messages.childElementCount > 0; }
function setRunning(value) {
  running = value;
  updateLearningAvailability();
  if(!value){stopping=false;activeTurnId=null;retrying=false;}
  $("stop-button").disabled=stopping;
  if (!value) recoveryStatus = "";
  updateSendAvailability();
  $("stop-button").hidden = !value;
  status(value ? "PI 正在回复…" : "就绪");
}
// Terminal events carry the turn that produced them. A late event from a stopped
// turn must never close the reply the user is waiting for now.
function turnMatches(response) {
  if (response.turnId === undefined || response.turnId === null) return true;
  if (!activeTurnId) return true;
  return response.turnId === activeTurnId;
}
function errorRow(message) {
  const row = document.createElement("div");
  row.className = "message-error";
  row.textContent = message;
  messages.append(row);
  refreshEmpty(); scrollToLatest();
}
function messageRow(role, text = "") {
  if(role==="user"){learningCandidate=null;
    // 新的用户消息让恢复出来的题目失效：与有回执的题目一致，旧题不能再点。
    for(const [key,state] of recoveredAnswerStates)if(state.status!=='answered'&&state.status!=='sending')recoveredAnswerStates.set(key,{status:'expired'});
    updateLearningAvailability();}
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  row.setAttribute("role", "article");
  row.setAttribute("aria-label", role === "user" ? "用户消息" : "助手消息");
  const col = document.createElement("div"); col.className = "message-col";
  const bubble = document.createElement("div"); bubble.className = "message-bubble";
  const content = document.createElement("div");
  content.className = role === "user" ? "message-user-text" : "prose-chat";
  if (role === "assistant") renderAssistant(content, text);
  else content.textContent = text;
  bubble.append(content); col.append(bubble); row.append(col); messages.append(row);
  refreshEmpty(); scrollToLatest();
  return content;
}
function attachmentPreview(content, items) {
  if (!items.length) return;
  const strip = document.createElement("div"); strip.className = "message-attachments";
  for (const item of items) {
    if (item.type === "image" || item.kind === "image") {
      const img = document.createElement("img");
      img.src = `data:${item.mimeType};base64,${item.data}`;
      img.alt = item.name || "图片附件";
      const preview=document.createElement("button");preview.type="button";preview.className="image-preview-button";preview.title="查看图片";preview.setAttribute("aria-label","查看图片");preview.append(img);preview.onclick=()=>{$("image-preview").src=img.src;$("image-preview").alt=img.alt;$("image-dialog").showModal();};strip.append(preview);
    } else {
      const file = document.createElement("span"); file.className = "message-file";
      file.textContent = item.name || "文件附件";
      strip.append(file);
    }
  }
  content.parentElement.append(strip);
}
function renderAttachments() {
  const strip = $("attachment-strip"); strip.replaceChildren();
  strip.hidden = !attachments.length;
  for (const item of attachments) {
    const chip = document.createElement("div"); chip.className = "attachment-chip";
    const img = item.kind === "image" ? document.createElement("img") : null;
    if (img) { img.src = `data:${item.mimeType};base64,${item.data}`; img.alt = ""; }
    const name = document.createElement("span"); name.textContent = item.name;
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.title = "移除图片";
    remove.addEventListener("click", () => { attachments = attachments.filter((candidate) => candidate !== item); renderAttachments(); });
    if (img) chip.append(img);
    chip.append(name, remove); strip.append(chip);
  }
  updateSendAvailability();
}
async function addFiles(files) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) { errorRow(`${file.name} 超过 5 MB`); continue; }
    if (attachments.length >= 8) { errorRow("一次最多添加 8 个附件"); break; }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    attachments.push({ kind: allowed.has(file.type) ? "image" : "file", name: file.name || "附件", mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) });
  }
  renderAttachments();
}
function disclosure({ kind, title, summary = "", detail = "", state = "done", id }) {
  const row = document.createElement("div"); row.className = `tool-row ${kind}`; row.dataset.recordId = crypto.randomUUID();
  const head = document.createElement("button"); head.type = "button"; head.className = "tool-row-header";
  head.setAttribute("aria-expanded", "false");
  const mark = document.createElement("span"); mark.className = "tool-row-icon"; mark.append(icon(kind === "thinking" ? "thinking" : kind === "permission" ? "shield" : "tools"));
  const name = document.createElement("span"); name.className = "tool-row-name"; name.textContent = title;
  if (state === "running") name.classList.add("running");
  const brief = document.createElement("span"); brief.className = "tool-row-summary"; brief.textContent = summary;
  const indicator = document.createElement("span"); indicator.className = `tool-row-state is-${state}`;
  const dot = document.createElement("span"); dot.className = "tool-row-state-dot";
  const label = document.createElement("span"); label.textContent = state === "running" ? "运行中" : state === "error" ? "失败" : "完成";
  indicator.append(dot, label);
  const caret = document.createElement("span"); caret.className = "tool-row-caret"; caret.textContent = "›";
  head.append(mark, name, brief, indicator, caret);
  const body = document.createElement("div"); body.className = "tool-row-body"; body.hidden = true;
  if (id) body.id = `detail-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const content = document.createElement("div"); content.className = "tool-row-content"; content.textContent = detail;
  body.append(content); row.append(head, body); messages.append(row);
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    row.classList.toggle("open", !body.hidden);
    head.setAttribute("aria-expanded", String(!body.hidden));
  });
  refreshEmpty(); scrollToLatest();
  return { row, head, name, brief, indicator, label, content };
}
function updateDisclosure(row, state) {
  row.name.classList.toggle("running", state === "running");
  row.indicator.className = `tool-row-state is-${state}`;
  row.label.textContent = state === "running" ? "运行中" : state === "error" ? "失败" : "完成";
}
function outcomeLabel(outcome) {
  return { truncated: "输出被截断", empty: "未生成回复", aborted: "已停止", error: "失败", unverified: "尚未通过验收" }[outcome?.status] || "完成";
}
function finishThinking(outcome) {
  if (!thinkingRow) return;
  updateDisclosure(thinkingRow, outcome && outcome.status !== "complete" ? "error" : "done");
  thinkingRow.label.textContent = outcomeLabel(outcome);
}
function historyOutcome(message) {
  if (message.outcome) return message.outcome;
  const stopReason = message.stopReason;
  if (["length", "error", "aborted"].includes(stopReason)) return { status: { length: "truncated", error: "error", aborted: "aborted" }[stopReason], message: message.errorMessage };
  const blocks = message.content || [];
  if (!blocks.some(block => block.type === "toolCall" || (block.type === "text" && (block.text || "").trim()))) return { status: "empty" };
  return { status: "complete" };
}
function pretty(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
function toolStart(event) {
  if(event.name==='show_learning'){
    const content=messageRow('assistant');content.append(Object.assign(document.createElement('p'),{className:'learning-pending',textContent:'正在整理学习图解…'}));
    learningRows.set(event.id,{content,sessionId:activeSessionId,fallback:typeof event.args?.fallbackText==='string'?event.args.fallbackText.slice(0,6000):''});return;
  }
  const detail = pretty(event.args);
  const row = disclosure({ kind: "tool", title: event.name || "工具", summary: detail.replace(/\s+/g, " ").slice(0, 120), detail, state: "running", id: event.id });
  toolRows.set(event.id, row);
}
function toolEnd(event) {
  const learning=learningRows.get(event.id);
  if(learning){
    const spec=!event.isError&&event.result?.details?.learning;
    if(spec){
      const question=spec.blocks?.find(b=>['choices','fill'].includes(b.type));
      if(question)learningCandidate={toolCallId:event.id,blockId:question.id,sessionId:learning.sessionId};
      const view=renderLearning(spec,{
        getReplyState:b=>learningStates.get(learningStateKey(learning.sessionId,event.id,b.id)),
        getDraft:b=>learningDraft(learning.sessionId,event.id,b.id),onDraft:(b,value)=>learningDraft(learning.sessionId,event.id,b.id,value),
        isAvailable:b=>!running&&learningCandidate?.toolCallId===event.id&&learningCandidate.blockId===b.id&&learning.sessionId===activeSessionId,
        onReply:(block,option)=>void sendUserMessage(replyText(block,option),{learningReply:{sessionId:learning.sessionId,toolCallId:event.id,blockId:block.id,...(block.type==='fill'?{answer:option}:{optionId:option.id})}})});
      learning.content.replaceChildren(view.root);learning.view=view;updateLearningAvailability();
    }else{
      const blocks=Array.isArray(event.result)?event.result:event.result?.content||[];
      learning.content.textContent=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'图解暂时无法显示，请继续阅读正文。';
    }
    scrollToLatest();return;
  }
  const row = toolRows.get(event.id);
  if (!row) return;
  const blocks = Array.isArray(event.result) ? event.result : event.result?.content || [];
  row.content.textContent += "\n\n结果\n" + (blocks.length ? blocks.filter(b => b.type === "text").map(b => b.text).join("\n") : pretty(event.result));
  for (const block of blocks) if (block.type === "image" && /^image\/(png|jpeg|webp)$/.test(block.mimeType)) { const img = document.createElement("img"); img.src = `data:${block.mimeType};base64,${block.data}`; img.alt = "工具截图"; img.className = "tool-image"; row.content.append(img); }
  updateDisclosure(row, event.isError ? "error" : "done");
  scrollToLatest();
}
function permissionRequest(event) {
  const row = disclosure({
    kind: "permission",
    title: `允许 ${event.name || "工具"}？`,
    summary: "等待确认",
    detail: pretty(event.args),
    state: "running",
    id: event.requestId,
  });
  const actions = document.createElement("div");
  actions.className = "permission-actions";
  const allow = document.createElement("button");
  allow.type = "button"; allow.className = "permission-allow"; allow.textContent = "允许";
  const deny = document.createElement("button");
  deny.type = "button"; deny.className = "permission-deny"; deny.textContent = "拒绝";
  actions.append(allow, deny); row.row.append(actions);
  const decide = async (decision) => {
    allow.disabled = true; deny.disabled = true;
    try { await command("tool_decision", { requestId: event.requestId, decision }, true); }
    catch (error) { allow.disabled = false; deny.disabled = false; errorRow(String(error)); }
  };
  allow.addEventListener("click", () => void decide("allow"));
  deny.addEventListener("click", () => void decide("deny"));
  permissionRows.set(event.requestId, { ...row, allow, deny });
}
function restoreHistory(history) {
  followLatest=true;
  learningStates.clear();for(const m of history){if(m.role==='user'&&m.learningReply){const r=m.learningReply;learningStates.set(learningStateKey(activeSessionId,r.toolCallId,r.blockId),{...r,status:'answered'});}}
  messages.replaceChildren(); learningRows.clear(); learningCandidate=null; toolRows.clear(); permissionRows.clear(); assistantRow = null; thinkingRow = null;
  for (const message of history) {
    if (message.role === "toolResult") {
      toolEnd({ id: message.toolCallId, isError: message.isError, result: {content:message.content,details:message.details} });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const outcome = message.role === "assistant" ? historyOutcome(message) : null;
    let content = null;
    for (const block of message.content || []) {
      if (block.type === "text") {
        if (!content) content = messageRow(message.role);
        if (message.role === "assistant") {
          content._source = (content._source || "") + (block.text || "");
          renderAssistant(content, content._source, message.messageId);
        } else content.textContent += block.text || "";
      } else if (block.type === "image" && message.role === "user") {
        if (!content) content = messageRow("user");
        attachmentPreview(content, [block]);
      } else if (block.type === "thinking") {
        const text = block.thinking ?? block.text ?? "";
        const row = disclosure({ kind: "thinking", title: "思考过程", summary: text.replace(/\s+/g, " ").slice(0, 120), detail: text, state: outcome?.status === "complete" ? "done" : "error" });
        row.label.textContent = outcomeLabel(outcome);
      } else if (block.type === "toolCall") {
        if(content&&message.messageId)content.closest(".message-row").dataset.messageId=message.messageId;
        toolStart({ id: block.id, name: block.name, args: block.arguments });
        if(toolRows.has(block.id))updateDisclosure(toolRows.get(block.id), "done");
        content=null;
      }
    }
    if(content&&message.messageId)content.closest('.message-row').dataset.messageId=message.messageId;
    if (message.role === "user" && content) {
      const marker = "附件文件（可使用 read 工具读取）：\n";
      const index = content.textContent.lastIndexOf(marker);
      if (index === 0 || (index > 1 && content.textContent.slice(index - 2, index) === "\n\n")) {
        const paths = content.textContent.slice(index + marker.length).split("\n").filter((line) => line.startsWith("- "));
        content.textContent = content.textContent.slice(0, index).trimEnd();
        attachmentPreview(content, paths.map((line) => ({
          kind: "file",
          name: line.slice(2).split(/[\\/]/).pop().replace(/^[0-9a-f-]{36}-/, ""),
        })));
      }
    }
    if (outcome?.status === "unverified") errorRow(outcome.message || "产物尚未通过视觉验收");
  }
  updateLearningAvailability();refreshEmpty(); scrollToLatest();
}
function closeHistory() {
  historyDrawer.hidden = true;
  $("history-overlay").hidden = true;
}
function openHistory() {
  historyDrawer.hidden = false;
  $("history-overlay").hidden = false;
  $("history-error").hidden = true;
  void command("list_sessions");
}
let showArchived=false;
const historyFoldState=new Map();
$("history-archives").onclick=()=>{showArchived=!showArchived;$("history-archives").textContent=showArchived?"返回会话":"查看已归档";void command("list_sessions");};
function renderSessions(sessions) {
  sessions=sessions.filter(item=>!!item.archived===showArchived);
  const list = $("history-list"); list.replaceChildren();
  function addConversation(parent, item) {
    const button = document.createElement("button"); button.type = "button";
    button.className = "history-item" + (item.id === activeSessionId ? " active" : "");
    button.textContent = item.title || "新对话"; button.title = button.textContent;
    button.onclick = async () => {
      try { await command("open_session", { sessionId: item.id }, true); closeHistory(); prompt.focus(); }
      catch (error) { $("history-error").textContent = String(error); $("history-error").hidden = false; }
    };
    const row=document.createElement("div");row.className="history-conversation";
    const archive=document.createElement("button");archive.type="button";archive.className="history-action";archive.title=item.archived?"恢复":"归档";archive.setAttribute("aria-label",archive.title);archive.append(icon("archive"));
    const remove=document.createElement("button");remove.type="button";remove.className="history-action";remove.title="删除";remove.setAttribute("aria-label","删除");remove.append(icon("close"));let timer;
    async function change(type,args){try{await command(type,{sessionId:item.id,...args},true);void command("list_sessions");}catch(e){$("history-error").textContent=String(e);$("history-error").hidden=false;}}
    archive.onclick=()=>change("archive_session",{archived:!item.archived});
    remove.onclick=()=>{if(remove.classList.contains("danger")){clearTimeout(timer);void change("delete_session",{confirm:true});}else{remove.title="确认删除";remove.setAttribute("aria-label","确认删除");remove.classList.add("danger");timer=setTimeout(()=>{remove.title="删除";remove.setAttribute("aria-label","删除");remove.classList.remove("danger");},3000);}};
    row.append(button,archive,remove);parent.append(row);
  }
  function section(key,text,parent=list,project=false){const group=document.createElement("details");group.className=project?"history-project history-group":"history-section-group history-group";group.open=historyFoldState.get(key)??true;group.dataset.group=key;group.ontoggle=()=>historyFoldState.set(key,group.open);const title=document.createElement("summary");title.append(icon("chevron"));if(project)title.append(icon("folder"));const label=document.createElement("span");label.className="history-group-title";label.textContent=text;title.append(label);group.append(title);parent.append(group);return group;}
  const looseGroup=section("sessions","会话");
  const loose = sessions.filter(item => !item.projectPath);
  loose.forEach(item => addConversation(looseGroup, item));
  if (!loose.length) { const e = document.createElement("p"); e.className = "history-empty"; e.textContent = "暂无无项目对话"; looseGroup.append(e); }
  const projectGroup=section("projects","项目");
  const projects = new Map();
  for (const item of sessions.filter(item => item.projectPath)) {
    if (!projects.has(item.projectPath)) projects.set(item.projectPath, []);
    projects.get(item.projectPath).push(item);
  }
  for (const [path, items] of projects) {
    const group=section(path,path.split(/[\\/]/).filter(Boolean).pop(),projectGroup,true);const heading=group.querySelector('summary');heading.title=path;const add=document.createElement('button');add.type='button';add.className='history-project-new';add.title='在此项目新建会话';add.setAttribute('aria-label','在此项目新建会话');add.append(icon('new'));add.onclick=async e=>{e.preventDefault();e.stopPropagation();try{await command('change_workspace',{path},true);closeHistory();prompt.focus();}catch(error){$('history-error').textContent=error.message||String(error);$('history-error').hidden=false;}};heading.append(add);items.forEach(item => addConversation(group, item));
  }
}
let chosenModel=null,activeModelKey="",activeThinking="off",statusModelResponse={};
function updateStatusModel(){const role=roles.find(r=>r.id===activeRoleId);$("status-model").textContent=[role?.name||statusModelResponse.roleName||"Agent",statusModelResponse.model?$("model-label").textContent:null,statusModelResponse.model?activeThinking:null].filter(Boolean).join(" · ");$("status-model").title=$("status-model").textContent;$("status-model").hidden=false;}
const thinkingNames={off:"思考关闭",minimal:"最少",low:"低",medium:"中等",high:"高",xhigh:"很高",max:"最高"};
function thinkingName(level,format){return level!=="off" && ["qwen","qwen-chat-template"].includes(format)?"思考开启":thinkingNames[level]||level;}
function updateModelChip(response){statusModelResponse=response;activeModelKey=response.model||"";activeThinking=response.thinkingLevel||"off";$("model-label").textContent=response.model?response.modelName||response.model:"选择模型";const name=thinkingName(activeThinking,response.thinkingFormat);$("model-thinking").textContent=/思考/.test(name)?name:`思考·${name}`;$("model-thinking").hidden=!response.model;$("model-button").title=response.model?`${$("model-label").textContent} · ${$("model-thinking").textContent}`:"选择模型";$("status-model").textContent=response.model?`${$("model-label").textContent} · ${activeThinking}`:"";$("status-model").title=$("status-model").textContent;$("status-model").hidden=!response.model;updateStatusModel();}
function resetModelStep(){chosenModel=null;$("model-step").hidden=false;$("thinking-step").hidden=true;$("model-step-title").textContent="选择模型";$("model-error").hidden=true;}
function chooseModel(model){chosenModel=model;$("model-step").hidden=true;$("thinking-step").hidden=false;$("model-step-title").textContent="选择思考档位";$("chosen-model-name").textContent=model.name||model.id;$("chosen-model-info").textContent=`${model.providerName||model.provider} · ${model.contextWindow?model.contextWindow.toLocaleString()+" 上下文":"上下文未知"}`;const format=model.compat?.thinkingFormat;renderThinkingLevels(model.thinkingLevels||["off"],activeModelKey===`${model.provider}/${model.id}`?activeThinking:"off",{thinkingFormat:format,reasoningKnown:model.reasoning!=null});$("thinking-hint").textContent=["qwen","qwen-chat-template"].includes(format)?"当前配置为 Qwen 思考开关，只发送开启/关闭，不区分深度。若服务支持 reasoning_effort，请在设置中选择该协议并配置档位。":model.thinkingDefaults?"服务未返回档位，使用默认五档；实际思考效果由模型服务决定，可在设置中调整协议。":model.reasoning===false?"此模型不支持思考。":"仅展示当前模型支持的选项。";$("thinking-level").focus();}
function renderModels() {
  const list = $("model-list"); list.replaceChildren();
  const search = $("model-search").value.toLowerCase();
  for (const model of modelCatalog.filter(m => `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(search))) {
    const button = document.createElement("button"); button.className = "model-option";
    const title = document.createElement("strong"); title.textContent = model.name || model.id;
    const meta = document.createElement("span"); meta.textContent = `${model.providerName || model.provider} · ${model.contextWindow ? Math.round(model.contextWindow / 1024) + "K 上下文" : "上下文未知"}`;
    button.append(title, meta); button.onclick = async () => {
      chooseModel(model);
    }; list.append(button);
  }
  if (!list.childElementCount) { const p = document.createElement("p"); p.textContent = "没有可用模型，请先配置提供商。"; list.append(p); }
}
function renderThinkingLevels(levels, selected, info = {}) {
  const names = { off: "思考关闭", minimal: "最少", low: "低", medium: "中等", high: "高", xhigh: "很高", max: "最高" };
  const picker = $("thinking-level");
  if (["qwen","qwen-chat-template"].includes(info.thinkingFormat)) names.medium="思考开启";
  picker.title=info.reasoningKnown === false ? "默认思考档位，实际效果由模型服务决定。" : "当前模型的思考选项";
  picker.replaceChildren();
  for (const level of levels || []) picker.add(new Option(names[level] || level, level));
  picker.value = levels?.includes(selected) ? selected : levels?.[0] || "off";
  picker.disabled = picker.options.length < 2;
}
function roleError(error) {
  $("role-error").textContent = String(error);
  $("role-error").hidden = false;
}
function openRoleEditor(role){
  editingRoleId=role.id;$('role-name').value=role.name;$('role-system').value=role.system||'';
  roleLearningMode.set(role);roleSkills.set(role.skills);$('role-editor').hidden=false;$('role-name').focus();
}
function renderRoles() {
  const list = $("roles-list");
  list.replaceChildren();
  const active = roles.find((role) => role.id === activeRoleId);
  $("role-label").textContent = active?.name || "Agent";updateStatusModel();
  for (const role of roles) {
    const row = document.createElement("div");
    row.className = `role-item${role.id === activeRoleId ? " active" : ""}`;
    const use = document.createElement("button");
    use.type = "button"; use.className = "role-item-name";
    use.textContent = `${role.name}${role.id === activeRoleId ? " · 当前" : ""}`;
    use.title = "使用此角色";
    use.addEventListener("click", async () => {
      try { await command("select_role", { roleId: role.id }, true); rolesDialog.close(); prompt.focus(); }
      catch (error) { roleError(error); }
    });
    const edit = document.createElement("button");
    edit.type = "button"; edit.textContent = "编辑";
    edit.addEventListener("click", () => openRoleEditor(role));
    row.append(use, edit);
    if (!role.builtin) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "role-delete"; remove.textContent = "删除";
      let confirmTimer;
      remove.addEventListener("click", async () => {
        if (!remove.classList.contains("confirm")) {
          remove.classList.add("confirm"); remove.textContent = "确认删除";
          confirmTimer = setTimeout(() => { remove.classList.remove("confirm"); remove.textContent = "删除"; }, 3000);
          return;
        }
        clearTimeout(confirmTimer);
        try { await command("delete_role", { roleId: role.id }, true); if (editingRoleId === role.id) $("role-editor").hidden = true; }
        catch (error) { roleError(error); }
      });
      row.append(remove);
    }
    list.append(row);
  }
}
async function newSession() {
  try {
    await command("new_session", { noProject: true }, true);
    closeHistory();
    prompt.focus();
  } catch (error) {
    errorRow(String(error));
  }
}
function onEvent(event) {
  const response = event.payload;
  if (!response || typeof response !== "object") return;
  const handledReply = Boolean(response.id && pending.has(response.id) && ["ack", "error", "done", "conversation", "file_staged", "goals", "sessions"].includes(response.type));
  if (handledReply) {
    const { resolve, reject, timer } = pending.get(response.id); clearTimeout(timer); pending.delete(response.id);
    response.type === "error" ? reject(new Error(response.message)) : resolve(response);
  }
  if(response.type==="ack"&&response.stale){stopping=false;$("stop-button").disabled=false;status(running?"这一轮已结束，正在等待 Agent 同步…":"已停止");}
  switch (response.type) {
    case 'learning_answer':{
      if(response.sessionId!==activeSessionId)break;
      learningStates.set(learningStateKey(response.sessionId,response.toolCallId,response.blockId),{...response,status:'answered'});
      try{localStorage.removeItem(learningDraftKey(response.sessionId,response.toolCallId,response.blockId));}catch{}
      updateLearningAvailability();break;
    }
    case "queue": {
      $("queue-items").replaceChildren();
      for (const [label, list] of [["引导", response.steering], ["排队", response.followUp]]) (list||[]).forEach((text,index)=>{const row=document.createElement("div");row.className="queue-item";const summary=document.createElement("span");summary.textContent=`${label} · ${text}`;row.append(summary);if(label==="排队"){const steer=document.createElement("button");steer.type="button";steer.textContent="发送（引导）";steer.onclick=async()=>{steer.disabled=true;try{await command("promote_queue",{text,index},true);}catch(e){errorRow(e.message||String(e));steer.disabled=false;}};row.append(steer);}$("queue-items").append(row);});
      $("queue-preview").hidden = !$("queue-items").childElementCount; break;
    }
    case "user_delivered":
      if (queuedTexts.has(response.text)) { const count = queuedTexts.get(response.text); if(count > 1) queuedTexts.set(response.text,count-1); else queuedTexts.delete(response.text); messageRow("user", response.text); assistantRow = null; thinkingRow = null; }
      break;
    case "tool_permission_result": {
      let row = permissionRows.get(response.requestId);
      if (!row && response.mode === "auto") row = disclosure({kind:"permission", title: response.name, summary:"自动审批", detail:"操作已在允许范围内自动批准。"});
      if (row) { row.row.querySelector(".permission-actions")?.remove(); row.brief.textContent = response.decision === "allow" ? (response.mode === "auto" ? "自动批准" : "已允许") : "已拒绝"; updateDisclosure(row, response.decision === "allow" ? "done" : "error"); permissionRows.delete(response.requestId); }
      break;
    }
    case "telemetry": renderTelemetry(response); break;
    case "ready": status("正在读取模型…"); break;
    case "models": modelCatalog = response.models || []; renderModels(); break;
    case "session":
      reconnectAttempts = 0;
      void goalsPanel.session(response.workspace || null, response.learningGoalsEnabled === true);
      $("model-label").textContent = response.modelName || response.model || "选择模型";
      $("model-button").title = response.model || "选择模型";
      if(activeSessionId!==(response.sessionId||"")){learningCandidate=null;updateLearningAvailability();}
      activeSessionId = response.sessionId || "";
      activeSessionName = response.sessionName || "";
      void canvasPanel.session(activeSessionId,response.canvasEnabled===true,response.canvasOpen===true,activeSessionName,response.learningModeEnabled===true||response.learningGoalsEnabled===true);
      updateModelChip(response);$("compaction-state").textContent=response.autoCompaction?"自动压缩已开启":"自动压缩已关闭";
      $("workspace-label").textContent = (response.workspace || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "无项目";
      $("workspace-button").title = response.workspace || "切换工作目录";
      if (response.roleId) { activeRoleId = response.roleId; renderRoles(); }
      void command("list_sessions");
      break;
    case "session_sync": if(turnMatches(response))setRunning(response.busy === true); break;
    case "retry_start": {
      // The SDK is reconnecting inside the same turn: the reply is still running, so
      // the stop button stays available and no terminal error row is shown for it.
      if(!turnMatches(response))break;
      const started=retryStarted(response);
      retrying=true;setRunning(started.running);
      recoveryStatus=started.status;
      status(recoveryStatus);
      break;
    }
    case "retry_end": {
      if(!turnMatches(response))break;
      const ended=retryEnded(response);
      retrying=ended.reconnecting;
      // The reconnect notice must also clear when the recovered reply opens with a
      // tool call or thinking instead of text.
      if(ended.recovered){recoveryStatus="";if(running&&!stopping)status("PI 正在回复…");}
      else if(ended.notice)status(ended.notice);
      break;
    }
    case "thinking_level": void command("get_state"); break;
    case "session_name":
      if (response.sessionId === activeSessionId) activeSessionName = response.name || "";
      void command("list_sessions");
      break;
    case "capabilities": roleSkills.update(response.state?.skills || []); break;
    case "roles":
      roles = response.roles || [];
      activeRoleId = response.activeId || "agent";
      renderRoles();
      break;
    case "credential_error": errorRow(response.message || "模型凭据无法读取"); break;
    case "knowledge_status": errorRow(response.message); break;
    case "knowledge_progress":
      if (running) status(response.phase === "local" ? "正在查找本地笔记…" : response.phase === "expanding" ? "正在扩展笔记检索词（最多等待 5 秒）…" : response.phase === "fallback" ? "已使用本地检索结果，正在生成回复…" : response.count ? `已找到 ${response.count} 段笔记，正在生成回复…` : "正在生成回复…");
      break;
    case "memory_status": if (!running) status(response.status === "organizing" ? "Agent 正在整理记忆…" : "就绪"); break;
    case "canvas": canvasPanel.event(response); break;
    case "sessions": projectPicker.update(response.sessions||[]);renderSessions(response.sessions || []); break;
    case "history": restoreHistory(response.messages || []); status("就绪"); break;
    case "stopping": stopping=true;$("stop-button").disabled=true;if(response.turnId)activeTurnId=response.turnId;status(response.message||"正在停止，等待请求结束…");break;
    case "turn_forced_end":
      setRunning(false);finishThinking({status:"aborted"});
      status("已停止（本地）");
      errorRow(response.message||"模型服务未结束上一条请求，已恢复本地输入。");
      break;
    case "request_phase": if(running&&!stopping)status(recoveryStatus||(response.phase==='waiting'?`等待模型返回，已等待 ${Math.max(1,Math.floor((response.elapsedMs||0)/60000))} 分钟，可手动停止。`:response.phase==='connecting'?'正在连接模型服务…':response.phase==='headers'?'模型服务已连接，等待首段内容…':response.phase==='first_body'?'已收到模型数据，正在生成回复…':'正在生成回复…'));break;
    case "model_queue": if (running&&!stopping) status(response.state === "waiting" ? (recoveryStatus ? recoveryStatus + "（等待模型服务空闲）" : "正在等待模型服务空闲…") : recoveryStatus || "正在准备模型请求…"); break;
    case "delta": {
      recoveryStatus = "";
      if (running&&!stopping) status("PI 正在回复…");
      if (response.kind === "thinking") {
        if (!thinkingRow) { thinkingRow = disclosure({ kind: "thinking", title: "思考过程", state: "running" }); thinkingRow.head.click(); }
        thinkingRow.content.textContent += response.text || "";
        thinkingRow.brief.textContent = thinkingRow.content.textContent.replace(/\s+/g, " ").slice(0, 120);
      } else {
        if (!assistantRow) assistantRow = messageRow("assistant");
        assistantRow._source = (assistantRow._source || "") + (response.text || "");
        renderAssistant(assistantRow, assistantRow._source, assistantRow.dataset.messageId || 'live');
      }
      scrollToLatest(); break;
    }
    case "tool_start": if(thinkingRow) updateDisclosure(thinkingRow,"done"); assistantRow=null; thinkingRow=null; toolStart(response); break;
    case "tool_end": toolEnd(response); break;
    case "tool_permission_request": permissionRequest(response); break;
    case "tool_permission_expired": {
      const row = permissionRows.get(response.requestId);
      if (row) {
        row.brief.textContent = response.reason || "已超时";
        row.allow.disabled = true;
        row.deny.disabled = true;
        row.row.querySelector(".permission-actions")?.remove();
        updateDisclosure(row, "error");
        permissionRows.delete(response.requestId);
      }
      break;
    }
    case "compaction": $("compaction-state").textContent=response.status==="running"?"正在压缩上下文…":response.status==="error"?"压缩失败："+response.message:response.status==="skipped"?response.message:"上下文已压缩";$("compact-now").disabled=response.status==="running";break;
    case "started": canvasPanel.foreground(); recoveryStatus = ""; retrying = false; submitted = null; turnErrorShown = false; activeTurnId = response.turnId || response.id || null; $("token-speed").textContent = "— tok/s"; setRunning(true); break;
    case "message_outcome":
      finishThinking(response.outcome);
      assistantRow = null; thinkingRow = null; break;
    case "recovery":
      setRunning(true); recoveryStatus = response.message || "正在恢复模型回复…"; status(recoveryStatus);
      break;
    case "visual_review":
      status(response.message || "正在视觉验收…");
      break;
    case "context_budget_warning":
      $("compaction-state").textContent=response.message;
      break;
    case "done": case "settled":
      if (response.final === false) break;
      if (!turnMatches(response)) break;
      setRunning(false); finishThinking(response.outcome);
      if(response.outcome?.status==='complete')canvasPanel.clearReference();
      // 恢复出来的题目：本轮成功结束后记成已回答，并把题干一起存下来供历史重放。
      // 这里不依赖 submitted（它可能在别的分支里已被清掉），而是按轮次配对。
      if(response.outcome?.status==='complete'&&recoveredPending&&(!recoveredPending.turnId||!response.turnId||recoveredPending.turnId===response.turnId)){
        const r=recoveredPending;recoveredPending=null;
        recoveredAnswerStates.set(r.key,{status:'answered',answer:r.answer});
        saveRecoveredAnswer(r.key,{question:r.question,answer:r.answer,text:r.text});
        setRecoveredStatus(r.key,'已发送你的回答：'+r.answer);
      }
      if (response.outcome && response.outcome.status !== "complete") {
        status(outcomeLabel(response.outcome));
        if (response.outcome.status !== "aborted" && !turnErrorShown) errorRow(response.outcome.message || outcomeLabel(response.outcome));
      }
      assistantRow = null; thinkingRow = null; break;
    case "error":
      if(handledReply)break;
      if(!turnMatches(response))break;
      // Agent events are broadcast to both windows. A settings failure must not
      // end the unrelated foreground turn or remove its stop button.
      if(response.id&&response.commandType!=="prompt"&&response.id!==activePromptId){
        if(response.id.startsWith(commandPrefix))errorRow(response.message||"操作失败");
        break;
      }
      // A failure is only terminal when the Agent itself reports that nothing is
      // running. An intermediate retry failure, or a send the Agent rejected while
      // the turn was still in flight, must not paint "就绪" or drop the stop button.
      if(turnStillRunning(response)){
        errorRow(response.message||"PI Agent 正在处理上一条消息");
        if(retrying&&!stopping)status(recoveryStatus||"模型服务连接失败，正在自动重连…");
        break;
      }
      finishThinking({ status: "error" });
      const failedLearningReply=submitted?.learningReply;
      const failedRecovered=submitted?.recoveredReply;
      if (submitted) {
        submitted.row.remove();
        if(!submitted.learningReply){prompt.value = submitted.text;attachments = submitted.images;}
        learningCandidate=submitted.previousQuestion;
        if(submitted.learningReply){const r=submitted.learningReply;learningStates.set(learningStateKey(r.sessionId,r.toolCallId,r.blockId),{status:'error',message:response.message});}
        if(failedRecovered)recoveredAnswerStates.set(failedRecovered.key,{status:'error',message:response.message});
        renderAttachments();
        submitted = null;
        refreshEmpty();
      }
      if (!handledReply&&!failedLearningReply) { errorRow(terminalErrorMessage(response)); turnErrorShown = true; }
      setRunning(false); break;
    case "disconnected":
      setRunning(false); status("PI Agent 已断开，正在恢复连接…");
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Agent 连接断开，请重新执行操作")); } pending.clear();
      if (reconnectAttempts < 3) {
        clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => { reconnectAttempts++; void command("init"); }, 600 * (reconnectAttempts + 1));
      } else { status("Agent 启动失败，请检查设置或 agent.log"); }
      break;
  }
}
$("compact-now").onclick=async()=>{const b=$("compact-now");b.disabled=true;try{await command("compact",{},true);}catch(e){$("compaction-state").textContent=String(e);}finally{b.disabled=false;}};
function renderTelemetry(data) {
  const percent = data.percent === null ? null : Math.min(100, Math.max(0, data.percent));
  $("context-percent").textContent = percent === null ? "?" : `${Math.round(percent)}`;
  $("context-arc").setAttribute("stroke-dasharray", `${(percent || 0) / 100 * 75.4} 75.4`);
  $("context-usage").classList.toggle("near-limit", percent !== null && percent >= 85);
  const detail = `${data.tokens === null ? "用量未知" : "约 " + data.tokens.toLocaleString() + " token"} / ${data.capacity ? data.capacity.toLocaleString() + " token" : "模型容量未知"}${percent === null ? "" : " · " + percent.toFixed(1) + "%"}`;
  $("context-usage").title = "上下文估算：" + detail; $("context-detail").textContent = detail;
  $("token-speed").textContent = data.tokPerSecond ? `${data.tokPerSecond.toFixed(1)} tok/s` : "— tok/s";
}
$("context-usage").onclick = () => $("context-dialog").showModal();
$("context-close").onclick = () => $("context-dialog").close();
document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-learning-source]');if(!button)return;
  void (async()=>{
    let dialog=document.getElementById('learning-source-dialog');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='learning-source-dialog';dialog.className='learning-source-dialog';dialog.setAttribute('aria-label','笔记来源');const header=document.createElement('header'),title=document.createElement('h3'),close=document.createElement('button'),body=document.createElement('div');title.className='learning-source-title';close.type='button';close.textContent='关闭';close.onclick=()=>dialog.close();body.className='learning-source-lines';header.append(title,close);dialog.append(header,body);document.body.append(dialog);}
    const ticket=crypto.randomUUID();dialog.dataset.ticket=ticket;dialog.querySelector('h3').textContent='正在读取笔记来源…';dialog.querySelector('.learning-source-lines').replaceChildren();if(!dialog.open)dialog.showModal();
    try{const result=await command('read_learning_source',{url:button.dataset.learningSource},true);if(dialog.dataset.ticket!==ticket||!dialog.open)return;dialog.querySelector('h3').textContent=result.source.title+' · 第 '+result.source.line+' 行';
      for(const line of result.source.lines){const row=document.createElement('span'),number=document.createElement('small');row.className='learning-source-line'+(line.number===result.source.line?' is-target':'');number.textContent=line.number;row.append(number,document.createTextNode(line.text));dialog.querySelector('.learning-source-lines').append(row);}dialog.querySelector('.is-target')?.scrollIntoView({block:'center'});
    }catch(error){if(dialog.dataset.ticket===ticket)dialog.querySelector('h3').textContent=error.message||String(error);}
  })();
});
document.addEventListener("click", event => {
  const link = event.target.closest?.("a[data-local-file]"); if (!link) return; event.preventDefault();
  void command("resolve_file", { path: link.dataset.localFile }, true).then(r => tauri.core.invoke("open_local_file", { path: r.path })).catch(e => errorRow(String(e.message || e)));
});
async function command(type, args = {}, awaitReply = false) {
  if(['open_session','new_session','select_role','change_workspace','save_role','set_role_learning'].includes(type))await canvasPanel.flush();
  if (!tauri) return Promise.reject(new Error("需要在 Tauri 桌面窗口中运行"));
  const id = `${commandPrefix}${++sequence}`;
  if(type==='prompt')activePromptId=id;
  const response = awaitReply ? new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error("操作超时，请检查 Agent 连接")); }, type==="compact"?180000:type==="abort"?15000:30000); pending.set(id, { resolve, reject, timer }); }) : Promise.resolve();
  tauri.core.invoke("agent_command", { command: { id, type, ...args } }).catch((error) => {
    if (pending.has(id)) { clearTimeout(pending.get(id).timer); pending.get(id).reject(error); pending.delete(id); }
    else onEvent({payload:{type:'error',id,commandType:type,message:String(error)}});
  });
  return response;
}
$("composer").addEventListener("submit", event=>{event.preventDefault();void sendUserMessage(prompt.value.trim());});
async function sendUserMessage(text,{learningReply,recoveredReply}={}) {
  followLatest=true;
  if((learningReply||recoveredReply)&&running)return;
  const previousQuestion=learningCandidate;
  if(learningReply)learningStates.set(learningStateKey(learningReply.sessionId,learningReply.toolCallId,learningReply.blockId),{status:'sending'});
  if(recoveredReply)recoveredAnswerStates.set(recoveredReply.key,{status:'sending'});
  if ((!text && !attachments.length)) return;
  if (running) {
    if(canvasPanel.reference()){errorRow("请等待当前回复结束后发送画布追问。");return;}
    if (attachments.length) { errorRow("引导和排队目前支持文本；附件请在当前任务完成后发送。"); return; }
    queuedTexts.set(text,(queuedTexts.get(text)||0)+1);
    try { await command("queue_message", { text, mode: "followUp" }, true); prompt.value = ""; updateSendAvailability(); } catch(e) { queuedTexts.delete(text); errorRow(String(e.message || e)); } return;
  }
  const items = learningReply?[]:attachments;
  running = true; updateLearningAvailability(); updateSendAvailability();
  status(learningReply?"正在发送回答…":"正在准备附件…");
  let outgoing = text;
  try {
    const staged = [];
    for (const item of items.filter((item) => item.kind === "file")) {
      const reply = await command("stage_file", { name: item.name, data: item.data }, true);
      staged.push(reply.path);
    }
    if (staged.length) outgoing += `${outgoing ? "\n\n" : ""}附件文件（可使用 read 工具读取）：\n${staged.map((path) => `- ${path}`).join("\n")}`;
  } catch (error) {
    running = false; updateLearningAvailability(); updateSendAvailability();
    status("就绪"); errorRow(String(error));
    return;
  }
  const userContent = messageRow("user", text);
  attachmentPreview(userContent, items);
  submitted = { text, images: items, row: userContent.closest(".message-row"),learningReply,recoveredReply,previousQuestion };
  assistantRow = null; thinkingRow = null;
  if(!learningReply){attachments = []; renderAttachments();
  prompt.value = ""; prompt.style.height = "auto";}
  setRunning(true);
  const reference=(learningReply||recoveredReply)?null:canvasPanel.reference();
  // 先落定 submitted 再发请求：模拟或极快的 Agent 可能在同一次 await 前就回报 done，
  // 那样“已完成”分支会看不到这条提交而漏掉已答状态。恢复出来的题目用 recoveredPending
  // 单独配对，不依赖 submitted（它可能在别的分支里已被清掉）。
  if(recoveredReply)recoveredPending={key:recoveredReply.key,answer:recoveredReply.answer,text:recoveredReply.text,question:recoveredReply.question,turnId:activeTurnId};
  void command("prompt", { text: outgoing, ...(learningReply?{learningReply}:{}), ...(reference?{canvasSessionId:reference.sessionId,canvasNodeId:reference.nodeId}:{}), images: items.filter((item) => item.kind === "image").map(({ data, mimeType }) => ({ type: "image", data, mimeType })) })
    .catch(error=>{if(!recoveredReply)return;recoveredPending=null;recoveredAnswerStates.set(recoveredReply.key,{status:'error',message:String(error?.message||error)});setRecoveredStatus(recoveredReply.key,'发送失败，可重试。'+String(error?.message||error).slice(0,120));});
}
$("add-image").addEventListener("click", () => $("attachment-picker").click());
$("attachment-picker").addEventListener("change", (event) => {
  void addFiles(Array.from(event.target.files || [])).catch((error) => errorRow(String(error)));
  event.target.value = "";
});
prompt.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files).catch((error) => errorRow(String(error)));
});
$("composer").addEventListener("dragover", (event) => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
$("composer").addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  void addFiles(Array.from(event.dataTransfer.files)).catch((error) => errorRow(String(error)));
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
prompt.addEventListener("input", () => {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 150)}px`;
  updateSendAvailability();
});
$("stop-button").addEventListener("click", async () => {
  if(stopping)return;
  stopping=true;$("stop-button").disabled=true;status("正在停止…");
  try{await command("abort",{promptId:activePromptId},true);}
  catch(error){
    // A missing acknowledgement means the request did not reach the Agent in
    // time, not that the turn ended: stay honest and let the user stop again.
    stopping=false;$("stop-button").disabled=false;
    status(running?"停止未确认，可再次点击停止":"已停止");
    errorRow(`${String(error.message||error)}；本轮可能仍在运行，可再次点击停止或等待 Agent 同步。`);
  }
});
$("header-new-chat").addEventListener("click", () => void newSession());
$("history-new-chat").addEventListener("click", () => void newSession());
$("history-button").addEventListener("click", openHistory);
$("history-close").addEventListener("click", closeHistory);
$("history-overlay").addEventListener("click", closeHistory);
$("history-rename").addEventListener("click", () => {
  if (!activeSessionId) return;
  $("rename-name").value = activeSessionName;
  $("rename-error").hidden = true;
  $("rename-dialog").showModal();
  $("rename-name").focus();
});
$("rename-close").addEventListener("click", () => $("rename-dialog").close());
$("rename-save").addEventListener("click", async () => {
  try {
    await command("rename_session", { name: $("rename-name").value }, true);
    $("rename-dialog").close();
  } catch (error) {
    $("rename-error").textContent = String(error);
    $("rename-error").hidden = false;
  }
});
$("settings-button").addEventListener("click", () => void tauri?.core.invoke("open_settings", { section: "general" }).catch(error => errorRow(String(error))));
$("model-button").addEventListener("click", () => { resetModelStep(); renderModels(); modelsDialog.showModal(); $("model-search").focus(); });
$("model-search").addEventListener("input", renderModels);
$("models-close").addEventListener("click", () => modelsDialog.close());
$("configure-models").addEventListener("click", () => { modelsDialog.close(); void tauri?.core.invoke("open_settings", { section: "models" }); });
$("model-back").onclick=()=>{resetModelStep();$("model-search").focus();};
$("model-apply").onclick=async()=>{if(!chosenModel)return;$("model-apply").disabled=true;$("model-error").hidden=true;try{await command("select_model",{provider:chosenModel.provider,model:chosenModel.id,thinkingLevel:$("thinking-level").value},true);modelsDialog.close();}catch(e){$("model-error").textContent=String(e.message||e);$("model-error").hidden=false;}finally{$("model-apply").disabled=false;}};
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
$("role-button").addEventListener("click", () => { $("role-error").hidden = true; renderRoles(); rolesDialog.showModal(); void command("get_state").catch(roleError); });
$("roles-close").addEventListener("click", () => rolesDialog.close());
$("roles-new").addEventListener("click", () => {
  editingRoleId = null;
  $("role-name").value = "";
  $("role-system").value = "";
  roleLearningMode.set();
  roleSkills.set();
  $("role-editor").hidden = false;
  $("role-name").focus();
});
$("role-cancel").addEventListener("click", () => { $("role-editor").hidden = true; editingRoleId = null; });
$("role-save").addEventListener("click", async () => {
  $("role-error").hidden = true;
  try {
    await command("save_role", { roleId: editingRoleId, name: $("role-name").value, system: $("role-system").value, skills: roleSkills.get(), ...roleLearningMode.get() }, true);
    $("role-editor").hidden = true;
    editingRoleId = null;
  } catch (error) { roleError(error); }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !historyDrawer.hidden) closeHistory();
});
updateSendAvailability();
if (tauri) {
  tauri.event.listen("agent-event", onEvent).then(() => command("init", {}, true)).then(finishStartup).catch((error) => {finishStartup(); errorRow(String(error));});
} else {
  status("请在 Tauri 桌面窗口中运行");
}
for (const [id,name] of Object.entries({"header-new-chat":"new","history-button":"history","settings-button":"settings","hide-button":"hide","activity-button":"activity","add-image":"new","stop-button":"stop","send-button":"send"})) $(id).replaceChildren(icon(name));
for (const [id,name] of [["model-button","spark"],["role-button","role"],["workspace-button","folder"]]) $(id).querySelector("svg")?.replaceWith(icon(name));
$("pin-button").replaceChildren(icon("pin"));
function showPinned(value){$("pin-button").setAttribute("aria-pressed",String(value));$("pin-button").title=value?"取消窗口置顶":"窗口置顶";$("pin-button").setAttribute("aria-label",$("pin-button").title);}
$("pin-button").onclick=async()=>{const button=$("pin-button");button.disabled=true;try{showPinned(await tauri.core.invoke("set_window_pinned",{pinned:button.getAttribute("aria-pressed")!=="true"}));}catch(e){errorRow(String(e));}finally{button.disabled=false;}};
if(tauri)void tauri.core.invoke("window_pinned").then(showPinned).catch(console.error);
$("hide-button").onclick = () => void tauri?.core.invoke("dismiss");
const activityOpen = new Set();
function renderActivity() {
  for(const row of $("activity-list").querySelectorAll(".tool-row")) { if(row.classList.contains("open")) activityOpen.add(row.dataset.recordId); else activityOpen.delete(row.dataset.recordId); }
  $("activity-list").replaceChildren();
  for(const row of messages.querySelectorAll(".tool-row")) {
    const copy=row.cloneNode(true); copy.querySelector(".permission-actions")?.remove();
    for(const node of copy.querySelectorAll("[id]")) node.removeAttribute("id");
    const open=activityOpen.has(row.dataset.recordId); copy.classList.toggle("open",open); copy.querySelector(".tool-row-body").hidden=!open; copy.querySelector(".tool-row-header").setAttribute("aria-expanded",String(open));
    $("activity-list").append(copy);
  }
  if(!$("activity-list").childElementCount){const p=document.createElement("p");p.textContent="本次会话尚无工具或思考记录。";$("activity-list").append(p);}
}
$("activity-button").onclick = () => { renderActivity(); $("activity-dialog").showModal(); };
$("activity-close").onclick = () => $("activity-dialog").close();
$("activity-list").onclick = event => { const head = event.target.closest(".tool-row-header"); if(!head)return;const body=head.nextElementSibling;body.hidden=!body.hidden;head.setAttribute("aria-expanded",String(!body.hidden));head.parentElement.classList.toggle("open",!body.hidden); };
let activityUpdate; new MutationObserver(()=>{if(!$("activity-dialog").open)return;clearTimeout(activityUpdate);activityUpdate=setTimeout(renderActivity,150);}).observe(messages,{subtree:true,childList:true,characterData:true});
$("clear-queue").onclick = () => { void command("clear_queue"); queuedTexts.clear(); };
windowHandles(tauri);
