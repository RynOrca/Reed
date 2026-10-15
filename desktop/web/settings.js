import { createLearningMode } from './learning-mode.js';
const $ = id => document.getElementById(id);
import { icon, windowHandles } from "./icons.js";
import { createSkillBindings } from "./role-skills.js";
const roleLearningMode=createLearningMode(document.getElementById('role-learning-mode'),{onChange:async(features)=>{if(!roleId)return false;await command('set_role_learning',{roleId,...features});return true;}});
const roleSkills = createSkillBindings($("role-skills"));
import { initBrand, saveAppearance, appVersion } from "./brand.js";
import { checkForUpdate, installUpdate, openReleasePage } from "./update.js";
const tauri = window.__TAURI__;
await initBrand(tauri);
let sequence = 0, templates = [], providers = [], editing = null, providerId = null, providerDraftId = null, recording = false, savedShortcut = "", memory = {}, roleId = null;
const commandPrefix=`settings-${crypto.randomUUID()}-`;
const pending = new Map();
const thinkingHint=document.createElement('p');thinkingHint.className='hint';thinkingHint.id='thinking-protocol-hint';$("manual-levels").parentElement.after(thinkingHint);
function explainThinkingProtocol(){const binary=["qwen","qwen-chat-template"].includes($("thinking-format").value);$("manual-levels").disabled=binary;thinkingHint.textContent=binary?"Qwen enable_thinking 仅控制开启/关闭，不区分 low、medium 等深度。仅在服务支持 reasoning_effort 时切换该协议。":"档位必须由模型服务支持；reasoning_effort 可配置 off、low、medium、high、xhigh。";}
$("thinking-format").onchange=()=>{const format=$("thinking-format").value;if(format)$("manual-reasoning").value="yes";if(format==="openai"&&["","medium"].includes($("manual-levels").value.trim()))$("manual-levels").value="low, medium, high, xhigh";explainThinkingProtocol();};
let browseRoot=null,browseNext=0,browseVersion=0,browseBusy=false;
const browseList=element("div"),browseMore=element("button","继续浏览","secondary"),browseStatus=element("p","","hint");
browseList.id="vault-browse";browseMore.id="vault-browse-more";browseMore.type="button";browseMore.hidden=true;
$("vault-results").after(browseList,browseMore,browseStatus);
browseMore.onclick=()=>action(()=>browseNotes());
// Cards follow the width actually available next to the sidebar, not the window
// width, so a three-column window never squeezes its cards.
function applyCardColumns(){
  for(const grid of [browseList,$("vault-results")]){
    if(!grid)continue;
    const width=grid.clientWidth;
    grid.style.setProperty("--vault-columns",String(width>=840?3:width>=560?2:1));
  }
}
// The preview shows note body text only: leading YAML frontmatter is metadata,
// and whitespace is collapsed so the five-line clamp matches real lines.
function excerpt(hit){const text=String(hit?.display??hit?.content??"").replace(/\s+/g," ").trim();return text.length>600?`${text.slice(0,600)}…`:text;}
async function browseNotes(reset=false){
  if(reset){browseVersion++;browseBusy=false;browseNext=0;browseList.replaceChildren();browseMore.hidden=true;browseStatus.textContent="";}
  if(!browseRoot||browseBusy||browseNext===null)return;
  const version=browseVersion,offset=browseNext;browseBusy=true;browseMore.disabled=true;
  try{const reply=await command("browse_notes",{offset});if(version!==browseVersion)return;
    for(const hit of reply.results||[]){const row=element("div",undefined,"card"),link=element("button",hit.title,"note-link");link.onclick=()=>action(async()=>{const file=await command("resolve_file",{path:hit.url});await tauri.core.invoke("open_local_file",{path:file.path});});row.append(link,element("p",excerpt(hit),"note-excerpt"));browseList.append(row);}
    applyCardColumns();
    browseNext=reply.next;browseMore.hidden=browseNext===null;browseStatus.textContent=reply.total?`已展示 ${offset+reply.results.length} / ${reply.total} 篇${browseNext===null?"，已全部展示。":""}`:"笔记库暂无可浏览的 Markdown 笔记。";
  }catch(error){if(version===browseVersion){browseMore.hidden=false;browseStatus.textContent=`浏览失败：${error.message}，点击继续浏览重试。`;}}
  finally{if(version===browseVersion){browseBusy=false;browseMore.disabled=false;}}
}
function notice(text, error = false) { $("notice").hidden = !text; $("notice").textContent = text; $("notice").classList.toggle("error", error); }
async function action(work) { try { await work(); } catch (error) { notice(String(error.message || error), true); } }

// 浏览区与检索结果互斥：检索后只显示结果，清空输入框回到浏览。
function setBrowseVisible(visible){browseList.hidden=!visible;browseMore.hidden=!visible||browseNext===null;browseStatus.hidden=!visible;}
function setSearchStatus(state,text){
  const node=$("vault-search-status");node.hidden=!text;node.textContent=text||"";
  node.classList.toggle("is-running",state==="running");node.classList.toggle("is-done",state==="done");
  node.replaceChildren();
  if(!text)return;
  if(state==="running"){const spin=element("span",undefined,"search-spinner");spin.setAttribute("aria-hidden","true");node.append(spin);}
  node.append(element("span",text));
}
let searching=false;
function searchNotes(){
  if(searching)return;
  const query=$("vault-query").value.trim();
  if(!query)return;
  searching=true;
  const results=$("vault-results"),button=$("vault-search-button");
  results.replaceChildren();setBrowseVisible(false);
  setSearchStatus("running","正在检索…");button.disabled=true;
  void action(async()=>{
    try{
      const reply=await command("search_notes",{query});
      const hits=reply.results||[];
      for(const hit of hits){
        const row=element("div",undefined,"card"),link=element("button",`${hit.title} · 第 ${hit.startLine}–${hit.endLine} 行`,"note-link");
        link.onclick=()=>action(async()=>{const file=await command("resolve_file",{path:hit.url});await tauri.core.invoke("open_local_file",{path:file.path});});
        row.append(link,element("p",excerpt(hit),"note-excerpt"));results.append(row);
      }
      applyCardColumns();
      setSearchStatus("done",hits.length?`成功检索 ${hits.length} 条`:"没有匹配段落");
      if(!hits.length)results.append(element("p","没有匹配段落。可以尝试笔记标题或更具体的关键词。清空输入框可回到浏览。","hint"));
    }catch(error){setSearchStatus("","");setBrowseVisible(true);throw error;}
    finally{searching=false;button.disabled=false;}
  });
}
if(typeof ResizeObserver==="function")new ResizeObserver(()=>applyCardColumns()).observe(document.querySelector("main"));
window.addEventListener("resize",applyCardColumns);
function command(type, args = {}) {
  const id = `${commandPrefix}${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(["save_provider","discover_models","refresh_model","update_model"].includes(type)?"模型设置操作超过 30 秒未完成，草稿已保留；请重试或检查模型服务。":"操作超过 30 秒未完成，请重试；若仍无响应，请检查 Agent 状态。")); }, 30000);
    pending.set(id, { resolve, reject, timer });
    tauri.core.invoke("agent_command", { command: { type, id, ...args } }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
}
const headings = { general: ["通用", "窗口与快捷键"], models: ["模型", "选择提供商，连接你的模型"], memory: ["记忆", "学习画像与独立工作经验，按需读取"], vault: ["笔记库", "引用你的 Obsidian 笔记，回到原文复习"], skills: ["技能仓库", "管理 Agent 可用的技能"], tools: ["工具", "搜索、浏览器与文件能力"], roles: ["角色", "角色说明作为系统指令，每轮生效"], about: ["关于", "轻量的个人 Agent 入口"] };
headings.mcp=["MCP","按需加载外部工具"];
headings.security = ["权限与范围", "文件范围与审批方式分别管理"]; headings.agent = ["Agent 能力", "实际加载的工具、扩展、技能与 MCP 状态"];
let agentCapabilities = {};
function renderAgent(state = agentCapabilities) {
  agentCapabilities = state;renderMcp(state.mcp||[]); $("approval-mode").value = state.approval || "manual"; $("file-access").value = state.access || "workspace";
  $("security-workspace").textContent = state.workspace || ""; $("security-readonly").textContent = state.readOnly?.filter(p=>!state.customReadOnly?.includes(p)).join("\n") || "未连接只读目录";
  $("agent-summary").textContent = `${state.tools?.filter(t=>t.active).length || 0} 个可用工具 · ${capabilities.skills?.filter(s=>s.enabled).length || 0} 个启用技能 · 终端已关闭`;
  $("agent-extensions").textContent = "内置扩展：" + (state.extensions || []).join("、"); $("agent-mcp").textContent = state.mcp?.length ? "MCP：" + state.mcp.map(s=>s.name+(s.connected?"（已连接）":"（按需）")).join("、") : "MCP：未连接服务器。现有浏览器、搜索和文件能力通过内置工具提供。";
  $("custom-readonly").replaceChildren();
  for(const path of state.customReadOnly||[]){const row=element("div",undefined,"readonly-item"),label=element("span",path);const remove=element("button","移除","secondary");remove.onclick=()=>action(()=>command("remove_readonly",{path}));row.append(label,remove);$("custom-readonly").append(row);}
  $("agent-tool-list").replaceChildren(); const query = $("agent-tool-query").value.toLowerCase();
  for (const tool of state.tools || []) { if (!(tool.name + " " + tool.description).toLowerCase().includes(query)) continue; const row = element("div", undefined, "card tool-capability"), title = element("h3", tool.name), status = element("span", tool.active ? "可用" : "未启用", "profile-status"); title.append(status); row.append(title, element("p", tool.description), element("small", "操作范围：" + tool.scope)); $("agent-tool-list").append(row); }
}
$("add-readonly").onclick=()=>action(async()=>{const path=await tauri.core.invoke("choose_workspace");if(path)await command("add_readonly",{path});});
$("agent-tool-query").oninput = () => renderAgent(); $("refresh-agent").onclick = () => action(()=>command("get_state"));
$("approval-mode").onchange = () => action(async()=>{try { await command("set_approval",{mode:$("approval-mode").value}); notice("审批方式已更新，适用于后续工具调用。"); } catch(e) { renderAgent(); throw e; }});
$("file-access").onchange = () => action(async()=>{try { await command("set_file_access",{mode:$("file-access").value}); notice("文件权限范围已更新。"); } catch(e) { renderAgent(); throw e; }});
let capabilities = {};
function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function renderCapabilities(state) {
  if(browseRoot!==(state.vaultPath||null)){browseRoot=state.vaultPath||null;void browseNotes(true);}
  capabilities = state;
  roleSkills.update(state.skills || []);
  $("vault-path").textContent = state.vaultPath || "未选择笔记库";
  $("web-enabled").checked = state.webEnabled; $("browser-enabled").checked = state.browserEnabled;
  $("tavily-state").textContent = state.keyError || (state.hasSearchKey ? "Key 已加密保存" : "尚未配置 Key");
  $("tavily-key").placeholder = state.hasSearchKey ? "已保存；留空保留当前 Key" : "输入 Tavily Key";
  renderSkills();
}
function renderSkills() {
  const query = $("skill-query").value.toLowerCase(); $("skill-list").replaceChildren();
  for (const skill of capabilities.skills || []) {
    if (!(skill.name + " " + skill.description).toLowerCase().includes(query)) continue;
    const row = element("div", undefined, "setting-row"), info = element("div"), title = element("h3", skill.name), description = element("p", skill.description);
    const view = element("button", "查看说明", "secondary"); view.onclick = () => action(async () => { const r = await command("skill_detail", { skillId: skill.id }); $("skill-detail").hidden = false; $("skill-detail").textContent = r.text; });
    info.append(title, description, view); const toggle = element("input"); toggle.type = "checkbox"; toggle.className = "switch"; toggle.checked = skill.enabled; toggle.setAttribute("aria-label", "启用 " + skill.name);
    toggle.onchange = () => action(async () => { try { await command("toggle_skill", { skillId: skill.id, enabled: toggle.checked }); } catch(e) { toggle.checked = !toggle.checked; throw e; } }); row.append(info, toggle); $("skill-list").append(row);
  }
  if (!(capabilities.skills || []).length) $("skill-list").append(element("p", "尚未导入技能。选择包含 SKILL.md 的本地目录即可。", "hint"));
}
$("skill-query").oninput = renderSkills;
$("import-skill").onclick = () => action(async () => { const path = await tauri.core.invoke("choose_workspace"); if (path) { await command("import_skill", { path }); notice("技能已导入并启用。当前会话保留，下一次回复即可使用。"); } });
$("choose-vault").onclick = () => action(async () => { const vaultPath = await tauri.core.invoke("choose_workspace"); if (vaultPath) { await command("configure_capabilities", { vaultPath }); notice("笔记库已连接，相关提问时会主动检索。"); } });
$("disconnect-vault").onclick = () => action(async () => { await command("configure_capabilities", { vaultPath: null }); $("vault-results").replaceChildren(); });
$("save-tavily").onclick = () => action(async () => { if (!$("tavily-key").value.trim()) throw new Error("请填写 Tavily Key"); await command("configure_capabilities", { key: $("tavily-key").value, webEnabled: true }); $("tavily-key").value = ""; notice("搜索 Key 已保存，联网搜索已开启。"); });
for (const [id, key] of [["web-enabled", "webEnabled"], ["browser-enabled", "browserEnabled"]]) $(id).onchange = () => action(async () => { try { await command("configure_capabilities", { [key]: $(id).checked }); } catch(e) { $(id).checked = !$(id).checked; throw e; } });
$("vault-search-form").onsubmit = event => { event.preventDefault(); searchNotes(); };
// 清空输入框回到浏览视图，避免检索结果和浏览卡片同时堆在页面上。
$("vault-query").addEventListener("input", () => {
  if ($("vault-query").value.trim()) return;
  $("vault-results").replaceChildren(); setSearchStatus("", ""); setBrowseVisible(true);
});
function renderLearner(profile) {
  const groups = [["学习目标", profile.goals || []], ["知识状态", profile.knowledge || []], ["误解记录", profile.misconceptions || []], ["学习偏好", profile.preferences || []]];
  $("learner-overview").replaceChildren(); $("learner-profile").replaceChildren();
  for (const [title, items] of groups) {
    const count = element("div", undefined, "profile-count"); count.append(element("span", title), element("strong", String(items.length))); $("learner-overview").append(count);
    const section = element("details", undefined, "profile-section"); section.open = true; section.append(element("summary", `${title} · ${items.length}`));
    for (const item of items) {
      const row = element("div", undefined, "memory-item"), info = element("div");
      info.append(element("h3", item.subject), element("p", item.detail), element("small", "依据：“" + item.evidence + "” · 会话 " + (item.source || "").slice(0, 8)));
      if (item.nextReview) info.append(element("p", "建议复习：" + new Date(item.nextReview).toLocaleDateString() + " · 掌握程度尚未评估", "hint"));
      const status = element("span", ({active:"进行中",completed:"已完成",needs_review:"待复习",resolved:"已纠正"})[item.status] || "已记录", "profile-status"); row.append(info, status); section.append(row);
    }
    if (!items.length) section.append(element("p", "Agent 会根据对话中的明确陈述自动整理。", "hint")); $("learner-profile").append(section);
  }
}
function showSection(section) {
  if (!headings[section]) section = "general";
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== section;
  for (const button of document.querySelectorAll("nav button")) button.classList.toggle("active", button.dataset.section === section);
  [$("page-title").textContent, $("page-description").textContent] = headings[section]; notice("");
  document.querySelector("main").scrollTop = 0;
}
function editProvider(template, provider = null) {
  editing = template; providerId = provider?.id || null; providerDraftId = provider?.clientRequestId || (provider ? null : crypto.randomUUID());
  $("provider-form").hidden = false; $("provider-heading").textContent = template.name;
  $("provider-name").value = provider?.name || template.name;
  $("base-url").value = provider?.baseUrl || template.baseUrl || "";
  $("protocol").value = provider?.protocol || template.protocol;
  $("parallel-requests").checked = provider?.parallelRequests === true;
  $("parallel-limit").value = provider?.maxConcurrentRequests || 2;
  syncParallelRequests();
  $("api-key").value = ""; $("api-key").placeholder = provider?.hasKey ? "已保存；留空保留当前 Key" : "无鉴权服务可留空";
  renderProviderModels(provider?.models || []);
  $("provider-form").scrollIntoView({ behavior: "smooth", block: "start" });
  $("base-url").focus(); notice("");
}
function renderProviders() {
  $("providers").replaceChildren();
  for (const provider of providers) {
    const button = document.createElement("button"); button.className = "configured";
    const title = document.createElement("span"); title.textContent = provider.name;
    const info = document.createElement("small"); info.textContent = `${provider.models.length} 个模型 · ${provider.credentialError || "编辑配置"}`;
    button.append(title, info); button.onclick = () => editProvider(templates.find(t => t.id === provider.template) || templates.find(t => t.id === "custom"), provider);
    const row=element("div",undefined,"provider-row");
    const remove=deletionButton("删除",async()=>{await command("delete_provider",{providerId:provider.id});if(providerId===provider.id){providerId=null;editing=null;$("provider-form").hidden=true;}notice("提供商配置已删除，对话历史保留。");});remove.setAttribute("aria-label",`删除 ${provider.name}`);row.append(button,remove);$("providers").append(row);
  }
  if (!providers.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "选择下方提供商开始配置。"; $("providers").append(p); }
  $("templates").replaceChildren();
  for (const template of templates) {
    const button = document.createElement("button"); button.className = "template-card";
    const mark = document.createElement("span"); mark.className = "provider-mark"; mark.textContent = ({ deepseek: "D", kimi: "K", minimax: "M", doubao: "火", mimo: "mi", qwen: "Q", custom: "C", openai: "◎", anthropic: "A" })[template.id] || template.name[0];
    const label = document.createElement("span"); label.textContent = template.name;
    const hint = document.createElement("small"); hint.textContent = template.id === "custom" ? "任意兼容接口" : "配置连接与凭据";
    label.append(hint); button.append(mark, label); button.onclick = () => editProvider(template); $("templates").append(button);
  }
  if (providerId) renderProviderModels(providers.find(p => p.id === providerId)?.models || []);
}
function modelEditor(config){$("manual-model").value=config.id;$("manual-context").value=config.contextWindow||"";$("manual-output").value=config.maxTokens||"";$("manual-reasoning").value=config.reasoning==null?"unknown":config.reasoning?"yes":"no";$("manual-vision").checked=config.input?.includes("image")||false;$("thinking-format").value=config.compat?.thinkingFormat||"";$("manual-levels").value=config.reasoning?config.thinkingLevels?.filter(l=>l!=="off").join(", ")||"":"";explainThinkingProtocol();document.querySelector(".advanced").open=true;$("manual-model").scrollIntoView({block:"nearest"});}
function renderProviderModels(models) {
  $("discovered-models").replaceChildren();
  for (const model of models) {
    const row = document.createElement("div"); row.className = "model-info";
    const info = document.createElement("div"), name = document.createElement("strong"), detail = document.createElement("small");
    name.textContent = model.name || model.id;
    const source = ({ service:"服务返回", "catalog+service":"服务 / PI 目录", user:"手动补充", unknown:"服务未提供能力信息" })[model.infoSource] || "PI 目录";
    detail.textContent = `${model.contextWindow ? model.contextWindow.toLocaleString() + " 上下文" : "上下文未知"} · ${model.maxTokens ? model.maxTokens.toLocaleString() + " 最大输出" : "输出上限沿用默认"} · ${model.thinkingLevels?.join(" / ") || (model.reasoning === true ? "支持思考" : model.reasoning === false ? "不支持思考" : "思考能力未知")} · ${source}`;
    info.append(name, detail);
    const use = document.createElement("button"); use.className = "secondary"; use.textContent = "获取配置";
    use.onclick = () => action(async () => {
      use.disabled=true;use.textContent="获取中…";
      try { const selectedProvider=providerId;const reply=await command("refresh_model",{providerId:selectedProvider,modelId:model.id});const config=reply.modelInfo;notice(`已获取 ${model.name||model.id} 的配置。${config.reasoning==null?"服务未提供思考能力，请在下方补充。":""}`);
        modelEditor(config);
      } finally {use.disabled=false;use.textContent="获取配置";}
    });
    const enabledLabel = document.createElement("label"); enabledLabel.className = "model-enabled";
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.className = "model-toggle"; enabled.checked = model.enabled !== false;
    enabled.setAttribute("aria-label", `将 ${model.name || model.id} 加入模型选择栏`);
    enabled.onchange = () => action(async () => {
      enabled.disabled = true;
      try { await command("update_model", { providerId, model: { id: model.id, enabled: enabled.checked } }); }
      catch (error) { enabled.checked = !enabled.checked; throw error; }
      finally { enabled.disabled = false; }
    });
    enabledLabel.append(enabled, document.createTextNode("可选"));
    const edit=document.createElement("button");edit.type="button";edit.className="secondary";edit.textContent="编辑";edit.onclick=()=>modelEditor(model);const actions=document.createElement("div");actions.className="model-actions";actions.append(enabledLabel,edit,use);row.append(info, actions); $("discovered-models").append(row);
  }
}
function syncParallelRequests(){
  const enabled=$("parallel-requests").checked;
  $("parallel-limit-row").hidden=!enabled;$("parallel-limit").disabled=!enabled;
}
$("parallel-requests").onchange=syncParallelRequests;
async function saveProvider() {
  if (!$("provider-form").reportValidity()) throw new Error("请填写必需信息");
  const reply = await command("save_provider", { providerId, clientRequestId: providerDraftId, template: editing.id, name: $("provider-name").value, protocol: $("protocol").value, baseUrl: $("base-url").value, parallelRequests:$("parallel-requests").checked, maxConcurrentRequests:Number($("parallel-limit").value), key: $("api-key").value });
  providerId = reply.providerId; $("api-key").value = ""; $("api-key").placeholder = "已保存；留空保留当前 Key";
  return reply;
}
$("provider-form").onsubmit = event => { event.preventDefault(); void action(async () => { const reply=await saveProvider(); notice(`${reply.message||"配置已保存"}。可继续获取模型与信息。`); }); };
$("discover").onclick = () => action(async () => {
  $("discover").disabled = true; notice("正在连接服务并获取模型信息…");
  try { await saveProvider(); await command("discover_models", { providerId }); renderProviderModels(providers.find(p => p.id === providerId)?.models || []); notice("已获取模型列表。接口缺失的能力信息显示为未知。"); }
  finally { $("discover").disabled = false; }
});
$("manual-save").onclick = () => action(async () => {
  const button=$("manual-save");button.disabled=true;button.textContent="保存中…";
  try{
  await saveProvider(); const value = $("manual-reasoning").value;
  const model = { id: $("manual-model").value.trim(), vision:$("manual-vision").checked, ...($("manual-context").value ? { contextWindow: Number($("manual-context").value) } : {}), ...($("manual-output").value ? { maxTokens: Number($("manual-output").value) } : {}), ...(value !== "unknown" ? { reasoning: value === "yes" } : {}), thinkingFormat: $("thinking-format").value };
  if ($("manual-levels").value.trim()) model.thinkingLevels = $("manual-levels").value.split(/[,，\s]+/).filter(Boolean);
  const savedModel=await command("update_model", { providerId, model });
  document.querySelector(".advanced").open=false;$("provider-form").hidden=true;editing=null;providerId=null;providerDraftId=null;
  notice(`${savedModel.message||`模型 ${model.id} 信息已保存`}。`);$("notice").scrollIntoView({block:"nearest"});
  }catch(error){notice(`保存失败：${error.message}`,true);$("notice").scrollIntoView({block:"nearest"});}
  finally{button.disabled=false;button.textContent="保存模型信息";}
});
$("cancel-provider").onclick = () => { $("provider-form").hidden = true; editing = null; providerId = null; providerDraftId = null; };
function deletionButton(label, work) {
  const button = document.createElement("button"); button.className = "secondary"; button.textContent = label; let timer;
  button.onclick = () => {
    if (!button.classList.contains("confirm")) { button.classList.add("confirm"); button.textContent = "确认删除"; timer = setTimeout(() => { button.classList.remove("confirm"); button.textContent = label; }, 3000); return; }
    clearTimeout(timer); void action(work);
  }; return button;
}
function renderMemory() {
  for (const layer of ["l1", "l2", "l3", "work"]) $(layer).checked = memory.enabled?.[layer] !== false;
  for (const [id, entries] of [["facts", memory.facts || []], ["notes", memory.notes || []], ["working",memory.working||[]]]) {
    const list = $(id); list.replaceChildren();
    for (const item of entries) {
      const row = document.createElement("div"); row.className = "memory-item";
      const content = document.createElement("div"), title = document.createElement("h3"), text = document.createElement("p"), source = document.createElement("small");
      title.textContent = item.title || item.key; text.textContent = item.body || item.content;
      source.textContent = item.updated ? `更新于 ${new Date(item.updated).toLocaleString()}${item.source ? " · 来源会话 " + item.source.slice(0, 8) : ""}` : "已有记忆";
      if(id==="working")source.textContent+=` · ${item.scope?"项目："+item.scope:"全局经验"}`;
      if(id==="working"){
        source.textContent+=` · 修订 ${item.revision||1}${item.status==="invalidated"?" · 已失效（不会召回）":""}`;
        if(item.status!=="invalidated"&&(item.verification||item.evidence)){
          const draftButton=element("button","生成技能草稿","secondary");draftButton.type="button";
          draftButton.onclick=()=>action(async()=>{draftButton.disabled=true;try{const {draft}=await command("draft_work_skill",{workId:item.id});
            const preview=element("details"),summary=element("summary","技能草稿（尚未启用）"),body=element("pre",draft.body,"note-excerpt"),enable=element("button","导入技能库","secondary");preview.open=true;enable.type="button";
            enable.onclick=()=>action(async()=>{enable.disabled=true;try{await command("import_skill",{path:draft.dir});enable.textContent="已导入，可在角色中绑定";notice("技能已导入，请在角色中绑定后使用。");}catch(error){enable.disabled=false;throw error;}});
            preview.append(summary,body,enable);content.append(preview);notice("已生成技能草稿，请检查适用条件和验证方法后导入。");
          }finally{draftButton.disabled=false;}});content.append(draftButton);
        }
      }
      content.prepend(title, text, source); row.append(content, deletionButton("删除", () => command(id === "facts" ? "memory_fact_delete" : id === "working" ? "memory_work_delete" : "memory_note_delete", id === "facts" ? { key: item.key } : id === "working" ? {title:item.title,workId:item.id} : { noteId: item.id }))); list.append(row);
    }
    if (!entries.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "尚无内容，Agent 会从对话中整理。"; list.append(p); }
  }
}
for (const layer of ["l1", "l2", "l3", "work"]) $(layer).onchange = () => action(async () => { try { await command("memory_enabled", { layer, enabled: $(layer).checked }); } catch(error) { $(layer).checked = !$(layer).checked; throw error; } });
$("organize").onclick = () => action(async () => { await command("memory_consolidate"); notice("Agent 已开始整理当前对话。"); });
function renderRoles(roles) {
  $("role-list").replaceChildren();
  for (const role of roles) {
    const row = document.createElement("div"); row.className = "memory-item";
    const name = document.createElement("strong"); name.textContent = role.name;
    const edit = document.createElement("button"); edit.className = "secondary"; edit.textContent = "编辑";
    edit.onclick = () => { roleId = role.id; $("role-name").value = role.name; $("role-system").value = role.system || ""; roleLearningMode.set(role); roleSkills.set(role.skills); $("role-form").scrollIntoView(); };
    // 按钮成组放在行尾：内置角色只有一个「编辑」，自定义角色还有「删除」，
    // 不分组的话 space-between 会让前者与后者错位（见 .row-actions 注释）。
    const actions = document.createElement("div"); actions.className = "row-actions";
    actions.append(edit);
    if (!role.builtin) actions.append(deletionButton("删除", () => command("delete_role", { roleId: role.id })));
    row.append(name, actions);
    $("role-list").append(row);
  }
}
$("role-new").onclick = () => { roleId = null; $("role-form").reset(); roleLearningMode.set(); roleSkills.set(); $("role-name").focus(); };
$("role-form").onsubmit = event => { event.preventDefault(); void action(async () => { await command("save_role", { roleId, name: $("role-name").value, system: $("role-system").value, skills: roleSkills.get(), ...roleLearningMode.get() }); roleId = null; $("role-form").reset(); roleLearningMode.set(); roleSkills.set(); notice("角色已保存，可在对话窗口选择。"); }); };
for(const id of ['appearance-theme','appearance-icon']) $(id).onchange=()=>action(()=>saveAppearance($("appearance-icon").value,$("appearance-theme").value));

// 「关于」页：显示版本号，支持检查更新与一键安装。
let pendingUpdate = null;
function updateStatus(text, error = false) { const el = $("update-status"); el.textContent = text; el.classList.toggle("error", error); }
function setProgress(ratio) { const box = $("update-progress"); box.hidden = ratio === null; if (ratio !== null) box.firstElementChild.style.width = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(1)}%`; }
void appVersion(tauri).then(version => { $("about-version").textContent = version || "未知"; });
$("check-update").onclick = () => action(async () => {
  const button = $("check-update"); button.disabled = true;
  $("install-update").hidden = true; $("open-release").hidden = true; setProgress(null);
  updateStatus("正在检查更新…");
  try {
    const result = await checkForUpdate(tauri);
    if (result.status === "available") {
      pendingUpdate = result.update;
      updateStatus(`发现新版本 ${result.latest}（当前 ${result.current}）。安装前会校验签名，完成后应用会自动重启。`);
      $("install-update").hidden = false;
    } else if (result.status === "available-manual") {
      pendingUpdate = null;
      updateStatus(`发现新版本 ${result.latest}（当前 ${result.current}）。当前版本未内置签名校验，请前往下载页手动更新。`);
      $("open-release").hidden = false;
    } else if (result.status === "current") {
      updateStatus(`已是最新版本（${result.current}）。`);
    } else {
      updateStatus(result.reason || "无法检查更新。", true);
    }
  } finally { button.disabled = false; }
});
$("install-update").onclick = () => action(async () => {
  if (!pendingUpdate) return;
  const button = $("install-update"); button.disabled = true; setProgress(0);
  updateStatus("正在下载更新…");
  let received = 0, total = 0;
  try {
    await installUpdate(pendingUpdate, { onProgress: ({ phase, total: size, chunk }) => {
      if (phase === "started") { total = size || 0; }
      else if (phase === "progress") { received += chunk || 0; setProgress(total ? received / total : 0); }
      else if (phase === "installing") { setProgress(1); updateStatus("正在安装并重启…"); }
    } });
    updateStatus("更新已安装，应用即将重启…");
  } catch (error) {
    setProgress(null); button.disabled = false;
    updateStatus(`更新失败：${String(error?.message || error).slice(0, 200)}`, true);
  }
});
$("open-release").onclick = () => action(() => openReleasePage());

$("autostart").onchange = () => action(async () => { try { await tauri.core.invoke("set_autostart", { enabled: $("autostart").checked }); } catch(error) { $("autostart").checked = !$("autostart").checked; throw error; } });
async function finishRecording() { recording = false; $("shortcut").textContent = savedShortcut || "录入快捷键"; await tauri.core.invoke("capture_shortcut", { active: false }); }
$("shortcut").onclick = () => action(async () => { if (recording) return; await tauri.core.invoke("capture_shortcut", { active: true }); recording = true; $("shortcut").textContent = "请按下组合键…"; $("shortcut").focus(); });
document.addEventListener("keydown", event => {
  if (!recording) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === "Escape") { void action(finishRecording); return; }
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
  const modifiers = [event.ctrlKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.metaKey ? "Super" : ""].filter(Boolean);
  const key = event.code === "Space" ? "Space" : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.code;
  if (!modifiers.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) { notice("请使用组合键或 F1–F24。", true); return; }
  recording = false;
  void action(async () => { try { savedShortcut = await tauri.core.invoke("set_shortcut", { shortcut: [...modifiers, key].join("+") }); notice("快捷键已保存。"); } finally { await finishRecording(); } });
});
window.addEventListener("blur", () => { if (recording) void action(finishRecording); });
$("close").onclick = () => action(async () => { if (recording) await finishRecording(); await tauri.core.invoke("dismiss"); });
for (const button of document.querySelectorAll("nav button")) button.onclick = () => showSection(button.dataset.section);
showSection(window.SUMMON_SETTINGS_SECTION || "general");
if (tauri) {
  void action(async () => {
    await tauri.event.listen("settings-section", event => { showSection(event.payload); void command("get_state").catch(error => notice(String(error), true)); });
    await tauri.event.listen("agent-event", event => {
      const r = event.payload;
      if (r.id && pending.has(r.id) && ["ack", "error"].includes(r.type)) { const p = pending.get(r.id); clearTimeout(p.timer); pending.delete(r.id); r.type === "error" ? p.reject(new Error(r.message)) : p.resolve(r); }
      if (r.type === "providers") { templates = r.templates || []; providers = r.providers || []; renderProviders(); renderOverviewModels(); }
      if (r.type === "session") { overviewSessionModel={provider:r.model?.split("/")[0],id:r.model?.split("/").slice(1).join("/")}; renderOverviewModels(); }
      if (r.type === "vault_overview_config") { overviewSavedSelection=r.selection||null; renderOverviewModels(overviewSavedSelection?JSON.stringify({providerId:overviewSavedSelection.providerId,modelId:overviewSavedSelection.modelId}):undefined); }
      if (r.type === "memory") { memory = r.state; renderMemory(); }
      if (r.type === "learner") renderLearner(r.state);
      if (r.type === "capabilities") renderCapabilities(r.state);
      if(r.type==="mcp_status"){agentCapabilities.mcp=r.servers;renderMcp(r.servers);}
      if (r.type === "agent_capabilities") { renderAgent(r); if($("notice").textContent.includes("Agent 连接断开")) notice(""); }
      if (r.type === "vault_overview") renderOverview(r);
      if (r.type === "roles") renderRoles(r.roles || []);
      if (r.type === "memory_status") $("memory-status").textContent = ({ organizing:" 正在整理…", saved:" 已整理", error:" 整理失败，可稍后重试" })[r.status] || "";
      if(r.type==="work_memory_status")notice(r.message||"工作经验状态已更新。",r.status==="error");
      if (r.type === "disconnected") { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Agent 连接断开")); } pending.clear(); notice("Agent 连接断开，请在主对话窗口恢复连接后重试。", true); }
    });
    const prefs = await tauri.core.invoke("desktop_preferences"); savedShortcut = prefs.activeShortcut || prefs.shortcut || ""; $("shortcut").textContent = savedShortcut || "录入快捷键"; $("autostart").checked = prefs.autostart === true;
    await command("get_state");
  });
} else notice("请在 Reed 苇桌面应用中打开设置。", true);
for (const button of document.querySelectorAll("nav button")) button.prepend(icon(({general:"settings",models:"model",memory:"memory",vault:"book",skills:"skill",tools:"tools",security:"shield",agent:"activity",mcp:"tools",roles:"role",about:"info"})[button.dataset.section]));
$("close").replaceChildren(icon("close")); windowHandles(tauri);

let editingMcp=null;
function renderMcp(servers){$("mcp-list").replaceChildren();for(const server of servers){const row=element("div",undefined,"card");row.append(element("h3",server.name),element("p",`${server.transport} · ${server.enabled?"启用":"停用"} · ${server.connected?"已连接":"按需连接"}`));
const edit=element("button","编辑","secondary");edit.onclick=()=>{editingMcp=server.id;$("mcp-name").value=server.name;$("mcp-transport").value=server.transport;$("mcp-url").value=server.url||"";$("mcp-command").value=server.command||"";$("mcp-args").value=JSON.stringify(server.args||[]);$("mcp-enabled").checked=server.enabled;$("mcp-key").value="";syncMcpTransport();};
const discover=element("button","发现工具","secondary");discover.onclick=()=>action(async()=>{discover.disabled=true;try{await command("discover_mcp",{serverId:server.id});notice("工具发现完成；空闲后自动断开。");}finally{discover.disabled=false;}});
const remove=deletionButton("删除",()=>command("delete_mcp",{serverId:server.id}));row.append(edit,discover,remove);if(server.tools?.length)row.append(element("pre",JSON.stringify(server.tools,null,2),"mcp-tools"));$("mcp-list").append(row);}}
$("mcp-new").onclick=()=>{editingMcp=null;$("mcp-form").reset();syncMcpTransport();};
$("mcp-form").onsubmit=e=>{e.preventDefault();void action(async()=>{await command("save_mcp",{serverId:editingMcp,name:$("mcp-name").value,transport:$("mcp-transport").value,url:$("mcp-url").value,command:$("mcp-command").value,args:JSON.parse($("mcp-args").value),key:$("mcp-key").value,enabled:$("mcp-enabled").checked});$("mcp-key").value="";notice("MCP 配置已保存，尚未启动服务器。");});};

function syncMcpTransport(){const http=$("mcp-transport").value==="http";$("mcp-http-fields").hidden=!http;$("mcp-key-field").hidden=!http;$("mcp-stdio-fields").hidden=http;}
$("mcp-transport").onchange=syncMcpTransport;syncMcpTransport();

let overviewPath=null,overviewSessionModel=null,overviewSavedSelection=null,overviewModelOptions=[],overviewLastState={state:'idle'};
function renderOverviewModels(preferred){
  const select=$("overview-model"),previous=preferred||select.value||(overviewSavedSelection?JSON.stringify({providerId:overviewSavedSelection.providerId,modelId:overviewSavedSelection.modelId}):"");overviewModelOptions=[];select.replaceChildren();
  for(const provider of providers)for(const model of provider.models||[]){if(model.enabled===false)continue;const value=JSON.stringify({providerId:provider.id,modelId:model.id});overviewModelOptions.push({value,providerId:provider.id,model});const option=element("option",`${provider.name||provider.id} · ${model.name||model.id}`);option.value=value;select.append(option);}
  const fallback=overviewModelOptions.find(x=>x.value===previous)||overviewModelOptions.find(x=>x.providerId===overviewSessionModel?.provider&&x.model.id===overviewSessionModel?.id)||overviewModelOptions[0];
  if(fallback)select.value=fallback.value;renderOverviewReasoning(overviewSavedSelection?.reasoning);renderOverview(overviewLastState);
}
function renderOverviewReasoning(preferred){const select=$("overview-reasoning"),old=preferred||select.value,selected=overviewModelOptions.find(x=>x.value===$("overview-model").value);select.replaceChildren();const levels=["off",...new Set((selected?.model.thinkingLevels||[]).filter(level=>level!=="off"))];for(const level of levels){const option=element("option",({off:"关闭思考",low:"低",medium:"中",high:"高",xhigh:"极高"})[level]||level);option.value=level;select.append(option);}select.value=levels.includes(old)?old:"off";}
$("overview-model").onchange=()=>{renderOverviewReasoning("off");void action(persistOverviewSelection);};
$("overview-reasoning").onchange=()=>void action(persistOverviewSelection);
function persistOverviewSelection(){const selected=overviewModelOptions.find(x=>x.value===$("overview-model").value);if(!selected)return Promise.resolve();overviewSavedSelection={providerId:selected.providerId,modelId:selected.model.id,reasoning:$("overview-reasoning").value};return command("save_vault_overview_config",overviewSavedSelection);}
function renderOverviewProgress(info,working){
  const bar=$("overview-progress"),fill=$("overview-progress-fill"),label=$("overview-progress-label");
  const percent=Number.isFinite(info.progress)?Math.round(Math.max(0,Math.min(1,info.progress))*100):null;
  // Finished, idle and error states keep the bar hidden; only a running task shows it.
  const visible=working&&percent!==null;
  bar.hidden=!visible;
  if(!visible)return;
  fill.style.width=`${percent}%`;
  label.textContent=Number.isFinite(info.batches)&&info.batches?`${percent}% · ${info.done||0}/${info.batches} 批${info.failed?`，${info.failed} 批待重试`:""}`:`${percent}%`;
  bar.setAttribute("aria-valuenow",String(percent));
}
function renderOverview(info){overviewLastState=info;overviewPath=info.path||null;const stopping=info.state==="stopping",working=stopping||["scanning","generating"].includes(info.state);const parallel=info.concurrency>1?` · 并发 ${info.concurrency}`:"";const status=info.state==="ready"?`${info.existing?"已恢复已有总览":"总览已生成并保存"}${info.model?` · ${info.model}`:" · 历史文件未记录模型"}${parallel}。原文件已保留，不会自动覆盖。\n${overviewPath}`:info.message||"选择模型和思考档位后，点击生成总览。";$("vault-overview-status").textContent=status;renderOverviewProgress(info,working);$("generate-overview").disabled=working||info.state==="ready"||!overviewModelOptions.length;$("generate-overview").textContent=info.state==="ready"?(info.existing?"已有总览已恢复":"总览已生成"):"生成 / 重试总览";$("overview-model").disabled=working;$("overview-reasoning").disabled=working;$("cancel-overview").hidden=!working;$("cancel-overview").textContent=stopping?"取消切换":"停止生成";$("open-overview").hidden=info.state!=="ready"||!overviewPath;}
$("generate-overview").onclick=()=>action(()=>{const selected=overviewModelOptions.find(x=>x.value===$("overview-model").value);if(!selected)throw new Error("请先在模型设置中配置可用模型");return command("generate_vault_overview",{providerId:selected.providerId,modelId:selected.model.id,reasoning:$("overview-reasoning").value});});
$("cancel-overview").onclick=()=>action(()=>command("cancel_vault_overview"));
$("open-overview").onclick=()=>action(async()=>{if(overviewPath){const r=await command("resolve_file",{path:overviewPath});await tauri.core.invoke("open_local_file",{path:r.path});}});
