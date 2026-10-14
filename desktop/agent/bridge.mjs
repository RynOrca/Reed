import { semanticMatcher } from "./memory-match.mjs";
import { createMemoryValueGate } from './memory-value.mjs';
import { ModelRequests } from './model-requests.mjs';
import { createAuxiliaryCompleter } from './auxiliary-runtime.mjs';
import { workMemoryExtension } from "./work-memory.mjs";
import {LazyMcp,MCP_TOOLS} from "./mcp.mjs";
import {UserConfig} from "./user-config.mjs";
import { createInterface } from "node:readline";
import { mkdir, stat, readFile, writeFile, appendFile, rename, realpath, unlink } from "node:fs/promises";
import { classifyAssistantOutcome } from "./turn-outcome.mjs";
import { createTurnRecovery } from "./turn-recovery.mjs";
import { createDiagnosticFetch, createRequestFetch } from "./stream-diagnostics.mjs";
import { createVisualReview, VISUAL_TOOLS } from "./visual-review.mjs";
import { createContextPolicy } from "./context-policy.mjs";
import { GoalStore } from "./goals.mjs";
import { roleFeatureExtension } from "./role-features.mjs";
import { VaultOverview } from "./vault-overview.mjs";
import { createWorkRecaller } from './work-recall.mjs';
import { join, resolve } from "node:path";
import { createApprovalGate } from "./approval.mjs";
import { RoleStore } from "./roles.mjs";
import { installLearningSkills, prepareRoleSkills, hasRequiredReview } from "./role-skills.mjs";
import { normalizeImages } from "./images.mjs";
import { stageFile } from "./files.mjs";
import { EndpointStore, REMOTE_PROVIDER, validateEndpoint } from "./endpoint.mjs";
import { MemoryStore } from "./memory.mjs";
import { ProviderStore } from "./providers.mjs";
import { createMemoryAgent, sessionDisallowsMemory } from "./memory-agent.mjs";
import { CapabilityStore, inside } from "./capabilities.mjs";
import { createLearningTools, LEARNING_TOOLS } from "./learning-tools.mjs";
import { LearnerStore, learnerExtension } from "./learner.mjs";
import { FileScope, sandboxTools, FILE_TOOLS } from "./sandbox.mjs";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const dataDir = process.env.SUMMON_DATA_DIR;
let cwd = process.env.SUMMON_WORKSPACE || process.cwd();
if (!dataDir) throw new Error("SUMMON_DATA_DIR is required");
await mkdir(dataDir, { recursive: true });
const agentDir = join(dataDir, "agent");
const sessionsDir = join(dataDir, "sessions");
await mkdir(agentDir, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
const neutralWorkspace = join(dataDir, "workspace");
await mkdir(neutralWorkspace, { recursive: true });
const userConfig=new UserConfig(dataDir);
const appStatePath = join(dataDir, "app-state.json");
const metadataPath = join(dataDir, "session-meta.json");
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }
async function saveJson(path, value) { await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2)); await rename(`${path}.tmp`, path); }
const appState = await readJson(appStatePath, {});
if (appState.provider === "unknown") { delete appState.provider; delete appState.modelId; }
const metadata = await readJson(metadataPath, {});
let projectPath = appState.projectPath || null;
if (projectPath && !(await stat(projectPath).catch(() => null))?.isDirectory()) projectPath = null;
cwd = projectPath || neutralWorkspace;
const roles = new RoleStore(dataDir,userConfig);
await roles.load();
const endpoint = new EndpointStore(agentDir);
const memory = new MemoryStore(dataDir, sessionsDir);
await memory.load();
const savedMemory=(await userConfig.read()).memoryEnabled;if(savedMemory)Object.assign(memory.state.enabled,savedMemory);
const providers = new ProviderStore(agentDir,{config:userConfig});
await providers.load();
let overviewSelection=(await userConfig.read()).vaultOverviewSelection||null;
const capabilities = new CapabilityStore(dataDir,{config:userConfig});
await capabilities.load();
capabilities.canUseSkill=skill=>!skill.experienceId||memory.workItems(cwd).some(item=>item.id===skill.experienceId&&(item.revision||1)===skill.experienceRevision);
await installLearningSkills(capabilities);
const learner = new LearnerStore(dataDir);
await learner.load();
const goals = new GoalStore(dataDir); await goals.initialize();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const diagnostic = async entry => {
  try { await appendFile(join(dataDir, "request-diagnostics.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), sessionId: session?.sessionId, ...entry }) + "\n"); }
  catch { process.stderr.write("Request diagnostic could not be saved\n"); }
};
const turnRecovery = createTurnRecovery({ send, diagnostic });
const contextPolicy = createContextPolicy({ dataDir, currentSession: () => session, send, diagnostic });
const modelRequests = new ModelRequests({providers:()=>providers.providers});
let runtime;
let runtimePending;
let turnController;
let providersPending = false;
let activePrompt;
let applyingProviders=false;
let providerRevision=0;
let session;
let busy = false;
let queue = Promise.resolve();
const securityPath = join(dataDir, "security.json");
const security = await userConfig.get("security",securityPath,{approval:"manual"});
const scope = new FileScope({ workspace: () => cwd, readOnly: () => [capabilities.state.vaultPath, join(dataDir,"skills"), join(dataDir, "attachments"), join(dataDir,"artifacts","screenshots"), contextPolicy.artifactsDir, ...(security.readOnly || [])].filter(Boolean), fullAccess: () => security.access === "full", protectedPaths: () => [
  {path:goals.dir,denyRead:!roles.current().learningGoalsEnabled},
  ...capabilities.state.skills.filter(skill=>skill.experienceId&&!capabilities.canUseSkill(skill)).map(skill=>({path:skill.path,denyRead:true})),
  ...["memory.json","learner.json","local-search.sqlite","local-search.sqlite-wal","local-search.sqlite-shm"].map(name=>({path:join(dataDir,name),denyRead:true})),
] });
capabilities.canRead = async path => {try {await scope.check(path);return true;}catch{return false;}};
const vaultOverview = new VaultOverview({capabilities,runtime:getRuntime,model:()=>overviewSelection?runtime?.getModel(overviewSelection.providerId,overviewSelection.modelId):session?.model,send,canRead:capabilities.canRead});
// Restore persisted navigation on startup; generation requires the user's model
// and reasoning choice, so no invisible inference job is started here.
const ensureOverview=()=>vaultOverview.running?Promise.resolve():vaultOverview.restore();
await vaultOverview.restore();
const visualReview = createVisualReview({ scope, send, enabled: () => capabilities.state.browserEnabled });
const mcp=new LazyMcp({config:userConfig,scope,send});await mcp.load();
const approvalGate = createApprovalGate(send, undefined, () => security.approval);
const judgeValue=createMemoryValueGate({runtime:getRuntime,currentSession:()=>session,learningEnabled:()=>roles.current().learnerProfileEnabled===true,workEnabled:()=>memory.state.enabled.work});
const memoryAgent = createMemoryAgent({ memory, learner, send, judgeValue, currentSession: () => session, runtime: getRuntime, enabled:()=>roles.current().learnerProfileEnabled === true });
memory.agentAllowed=learner.agentAllowed=source=>roles.current().learnerProfileEnabled===true&&!sessionDisallowsMemory(session)&&source===session?.sessionId;
memory.matchTopic=learner.matchTopic=semanticMatcher({runtime:getRuntime,model:()=>session?.model?.provider!=="unknown"?session?.model:null,allowed:()=>roles.current().learnerProfileEnabled===true&&!sessionDisallowsMemory(session)});
memory.workAllowed=source=>memory.state.enabled.work&&!sessionDisallowsMemory(session)&&source===session?.sessionId;
memory.recallWork=createWorkRecaller({memory,runtime:getRuntime,model:()=>session?.model});
memory.matchWorkTopic=semanticMatcher({runtime:getRuntime,model:()=>session?.model?.provider!=="unknown"?session?.model:null,allowed:()=>memory.state.enabled.work&&!sessionDisallowsMemory(session)});
const preparedSkills=new Map(),preparedReviews=new Set();
let reviewReadKey=null;
const lastUserPrompt=()=>{const u=session?.state.messages.findLast(m=>m.role==="user");return typeof u?.content==="string"?u.content:(u?.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");};
const reviewEnabled=(prompt=lastUserPrompt())=>reviewReadKey===session?.sessionId+"\n"+prompt||preparedReviews.has(roles.activeId+"\n"+prompt);
const workingTools=workMemoryExtension({memory,learner,roles,currentSession:()=>session,reviewEnabled,send,judgeValue,runtime:getRuntime,currentWorkspace:()=>cwd});
const reviewGate=pi=>pi.on("tool_result",event=>{
  if(event.toolName!=="read"||event.isError||!roles.current().learnerProfileEnabled)return;
  const skill=capabilities.state.skills.find(s=>s.name==="spaced-review"&&s.enabled&&roles.current().skills.some(b=>b.skillId===s.id));
  if(skill&&event.input?.path&&resolve(cwd,event.input.path)===resolve(skill.path,"SKILL.md"))reviewReadKey=session.sessionId+"\n"+lastUserPrompt();
});
async function prepareSkills(text) {
  reviewReadKey=null;
  const key=roles.activeId+'\n'+text;
  preparedSkills.set(key,await prepareRoleSkills(roles.current(),capabilities,text));
  preparedReviews.delete(key);
  if(hasRequiredReview(roles.current(),capabilities,text))preparedReviews.add(key);
  if(preparedSkills.size>100){const oldest=preparedSkills.keys().next().value;preparedSkills.delete(oldest);preparedReviews.delete(oldest);}
}
const learningTools = createLearningTools({ capabilities, currentWorkspace: () => cwd, roles, send, scope, vaultOverview,runtime:getRuntime,model:()=>session?.model, turnSignal:()=>turnController?.signal,roleSkillInstructions: prompt=>prepareRoleSkills(roles.current(),capabilities,prompt) });
const learnerTools = learnerExtension({ learner, memory, judgeValue, currentSession: () => session, send, enabled:()=>roles.current().learnerProfileEnabled === true });
const roleFeatures = roleFeatureExtension({roles,goals,project:()=>projectPath,workspace:()=>cwd,learner,memory,currentSession:()=>session,reviewEnabled});
let generationStart = null, firstDelta = null, outputTokens = 0, generationMs = 0, missingUsage = false;
function emitTelemetry() {
  const model = session?.model;
  const info = model && runtime ? providers.modelInfo(model.provider, model.id, runtime) : null;
  const usage = session?.getContextUsage();
  const capacity = info?.contextWindow || null;
  const tokens = usage?.tokens ?? null;
  send({ type: "telemetry", tokens, capacity, percent: capacity && tokens !== null ? tokens / capacity * 100 : null, estimated: true, outputTokens: missingUsage ? null : outputTokens || null, tokPerSecond: !missingUsage && generationMs > 0 && outputTokens > 0 ? outputTokens / (generationMs / 1000) : null });
}

async function getRuntime() {
  if (runtime) return runtime;
  if (!runtimePending) runtimePending = (async () => {
    const created = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    try {
      const savedKey = await endpoint.loadKey();
      if (savedKey) await created.setRuntimeApiKey(REMOTE_PROVIDER, savedKey);
    } catch (error) {
      send({ type: "credential_error", message: `远程模型凭据无法读取，请重新输入 Key：${error.message}` });
    }
    await providers.install(created);
    const completeAuxiliary = createAuxiliaryCompleter(created.completeSimple.bind(created));
    created.completeSimple = (model, context, options={}) => {
      const {requestPriority='foreground',requestTimeoutMs,queueTimeoutMs,onRequestState,...requestOptions}=options;
      requestOptions.fetch = createRequestFetch(options.fetch || globalThis.fetch, {signal:options.signal, diagnostic:entry=>diagnostic({...entry,provider:model.provider,model:model.id,requestGroup:'auxiliary'})});
      if(requestTimeoutMs!==undefined)return modelRequests.complete(model,{signal:options.signal,priority:requestPriority,requestTimeoutMs,queueTimeoutMs,onState:onRequestState},signal=>completeAuxiliary(model,context,{...requestOptions,signal}));
      return modelRequests.run(model,{signal:options.signal,priority:requestPriority},()=>completeAuxiliary(model,context,requestOptions));
    };
    runtime = created;
    return created;
  })().catch(error=>{runtimePending=null;throw error;});
  return runtimePending;
}

// Persist settings immediately, but never mutate credentials/catalog of a running
// foreground turn. The next turn gets the new configuration after settlement.
async function providerRuntime() {
  const current = await getRuntime();
  if (!busy&&!vaultOverview.running) return current;
  return { getModels:()=>current.getModels(),getModel:(...args)=>current.getModel(...args),
    refresh:async()=>{providersPending=true;providerRevision++;},setRuntimeApiKey:async()=>{providersPending=true;providerRevision++;} };
}
async function applyProviders() {
  if(!providersPending||vaultOverview.running)return;
  const revision=providerRevision;
  await providers.install(await getRuntime());providersPending=revision!==providerRevision;modelRequests.refresh();
  if(session?.model){const updated=runtime.getModel(session.model.provider,session.model.id);if(updated)await session.setModel(updated);else if(session.model.provider!=='unknown')await openSession();}
}
async function flushProviders(){if(!busy&&providersPending&&!applyingProviders){applyingProviders=true;try{await applyProviders();await emitState();}catch(error){send({type:'credential_error',message:`配置已保存但暂未应用：${error.message}`});}finally{applyingProviders=false;}}}

async function openSession(provider, modelId, sessionManager) {
  memoryAgent.cancel();
  workingTools.cancel();
  if (!sessionManager) {
    if (session) sessionManager = session.sessionManager;
    else {
      const saved = (await SessionManager.listAll(sessionsDir)).find((item) => item.id === appState.activeSessionId);
      sessionManager = saved ? SessionManager.open(saved.path, sessionsDir, cwd) : SessionManager.create(cwd, sessionsDir);
    }
  }
  approvalGate.cancel("会话已切换，工具操作未执行");
  const models = await getRuntime();
  const disabled=providers.providers.find(p=>p.id===provider)?.models.find(m=>m.id===modelId)?.enabled===false;
  const model = provider && modelId && !disabled ? models.getModel(provider, modelId) : undefined;
  if (provider && modelId && !model && !disabled) throw new Error(`Unknown model: ${provider}/${modelId}`);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  contextPolicy.bindSettings(settingsManager, model);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    additionalSkillPaths: capabilities.enabledSkills(),
    extensionFactories: [pi => scope.extension(pi), roleFeatures, pi => {
      pi.on("tool_call",event=>{
        const readonly=["read","ls","find","grep","current_time","web_search","fetch_url","search_notes","recall_memory"];
        if(roles.activeId==="planner" && !readonly.includes(event.toolName)) return {block:true,terminate:true,reason:"Planner 仅允许只读调查，请切换 Agent 执行操作"};
      });
    }, approvalGate.extension, workingTools, reviewGate, memoryAgent.extension, learningTools.extension, learnerTools,pi=>mcp.extension(pi),contextPolicy.extension,turnRecovery.extension,visualReview.extension],
    appendSystemPromptOverride: (base) => {
      const instructions = roles.current()?.system;
      return instructions ? [...base, instructions] : base;
    },
  });
  await resourceLoader.reload();
  const created = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model,
    tools: roles.activeId==="planner" ? ["read","ls","find","grep","current_time","web_search","fetch_url","search_notes"] : [...FILE_TOOLS, "remember_work", "recall_memory", "draft_work_skill", "report_work_use", ...(roles.current().learnerProfileEnabled ? ["remember", "record_learning_event"] : []), ...LEARNING_TOOLS,...MCP_TOOLS,...VISUAL_TOOLS],
    customTools: sandboxTools(scope),
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  session?.dispose();
  session = created.session;
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const signal=AbortSignal.any([options?.signal,turnController?.signal].filter(Boolean));
    return modelRequests.stream(model, {
    signal, priority:'foreground', onWait:()=>send({type:'model_queue',state:'waiting'}),
  },()=>{
    send({type:'model_queue',state:'running'});
    return streamFunction(model, context, {
      ...options, signal, maxRetries:0,
      fetch: createDiagnosticFetch(createRequestFetch(options?.fetch || globalThis.fetch, {signal,diagnostic:entry=>diagnostic({...entry,provider:model.provider,model:model.id,requestGroup:'foreground'}),
        onPhase:phase=>{if(busy&&!signal.aborted)send({type:'request_phase',phase});}}), diagnostic),
    });
  });
  };
  metadata[session.sessionId] = { ...metadata[session.sessionId], projectPath };
  Object.assign(appState, { activeSessionId: session.sessionId, projectPath, provider: session.model?.provider, modelId: session.model?.id });
  await saveJson(metadataPath, metadata); await saveJson(appStatePath, appState);
  session.subscribe((event) => {
    if(event.type==="compaction_start" || event.type==="compaction_end") send({type:"compaction",status:event.type.endsWith("start")?"running":event.errorMessage?"error":event.aborted?"skipped":"done",message:event.errorMessage||(event.aborted?"压缩未完成，原上下文已保留":""),enabled:session.autoCompactionEnabled});
    if (event.type === "queue_update") send({ type: "queue", steering: event.steering, followUp: event.followUp });
    if (event.type === "message_start" && event.message.role === "user" && busy) send({ type: "user_delivered", text: typeof event.message.content === "string" ? event.message.content : event.message.content?.filter(b => b.type === "text").map(b => b.text).join("\n") });
    if (event.type === "message_start" && event.message.role === "assistant") { generationStart = performance.now(); firstDelta = null; }
    if (event.type === "message_end" && event.message.role === "assistant") {
      send({ type: "message_outcome", outcome: classifyAssistantOutcome(event.message) });
      const n = event.message.usage?.output;
      if (Number.isFinite(n) && n > 0) { outputTokens += n; generationMs += Math.max(1, performance.now() - (generationStart ?? firstDelta ?? performance.now())); }
      else if (event.message.stopReason !== "error" && event.message.content?.some(b => b.type === "text" || b.type === "thinking")) missingUsage = true;
      emitTelemetry();
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta") {
        firstDelta ??= performance.now();
        send({ type: "delta", kind: update.type === "text_delta" ? "text" : "thinking", text: update.delta });
      }
    } else if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
      if (!turnRecovery.willRecover(event.message)) send({ type: "error", message: classifyAssistantOutcome(event.message).message || "模型请求失败，请检查服务地址、凭据和模型信息" });
    } else if (event.type === "tool_execution_start") {
      send({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      send({ type: "tool_end", id: event.toolCallId, isError: event.isError, result: event.result });
    } else if (event.type === "agent_settled") {
      if (!busy) send({ type: "settled", outcome: visualReview.outcome(turnRecovery.outcome()) });
    }
  });
  emitSession();
  outputTokens = 0; generationMs = 0; missingUsage = false; emitTelemetry();
  emitHistory();
}

function emitHistory() {
  const historyBranch = session.sessionManager.getBranch();
  const visualOutcomes = new Map(historyBranch.filter(entry => entry.type === "custom" && entry.customType === "reed_turn_verification").map(entry => [entry.data?.messageEntryId, entry.data?.outcome]));
  send({
    type: "history",
    messages: historyBranch.filter(entry => entry.type === "message").map(entry => ({ ...entry.message, reedOutcome: visualOutcomes.get(entry.id) })).map((message) => ({
      role: message.role,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      outcome: message.role === "assistant" ? message.reedOutcome || classifyAssistantOutcome(message) : undefined,
      content: (Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }]).filter((block) =>
        block.type === "text" || block.type === "thinking" || block.type === "toolCall" || block.type === "image"
      ).map((block) => ({ type: block.type, text: block.type === "thinking" ? block.thinking ?? block.text : block.text, name: block.name, id: block.id, arguments: block.arguments, data: block.data, mimeType: block.mimeType })),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    })),
  });
}

function thinkingLevels() {
  const model = session?.model;
  return model && runtime ? providers.modelInfo(model.provider, model.id, runtime).thinkingLevels : ["off"];
}
function thinkingInfo() { const model=session?.model; const info=model && runtime ? providers.modelInfo(model.provider,model.id,runtime) : null; return {thinkingFormat:info?.compat?.thinkingFormat,reasoningKnown:info?.reasoning != null}; }
function emitSession() {
  if (!session) return;
  send({ type: "session", autoCompaction:session.autoCompactionEnabled, model: session.model && session.model.provider !== "unknown" ? `${session.model.provider}/${session.model.id}` : null, modelName: session.model?.provider !== "unknown" ? session.model?.name || session.model?.id : null, sessionId: session.sessionId, sessionName: session.sessionName || "", thinkingLevel: session.thinkingLevel, availableThinkingLevels: thinkingLevels(), ...thinkingInfo(), workspace: projectPath, roleId: roles.activeId, roleName:roles.current().name, learningGoalsEnabled:roles.current().learningGoalsEnabled, learnerProfileEnabled:roles.current().learnerProfileEnabled });
}
async function emitState() {
  const models = await getRuntime();
  const available = await models.getAvailable();
  send({ type: "models", models: available.filter(model=>providers.providers.find(p=>p.id===model.provider)?.models.find(m=>m.id===model.id)?.enabled!==false).map((model) => ({ ...providers.modelInfo(model.provider, model.id, models), provider: model.provider, id: model.id, name: model.name })) });
  send({ type: "providers", providers: providers.snapshot().map(provider=>({...provider,models:provider.models.map(model=>model.enabled===false?model:{...model,thinkingLevels:providers.modelInfo(provider.id,model.id,models).thinkingLevels})})), templates: providers.templates(models),pending:providersPending });
  send({ type: "roles", ...roles.list() });
  send({ type: "memory", state: memory.snapshot() });
  send({ type: "learner", state: learner.snapshot() });
  send({ type: "capabilities", state: capabilities.snapshot() });
  const active = new Set(session?.getActiveToolNames() || []);
  send({ type: "agent_capabilities", approval: security.approval, access: security.access === "full" ? "full" : "workspace", workspace: cwd, readOnly: scope.readOnly(), customReadOnly: security.readOnly || [], tools: (session?.getAllTools() || []).map(t => ({ name: t.name, description: t.description, active: active.has(t.name) && !(["web_search", "fetch_url"].includes(t.name) && (!capabilities.state.webEnabled || !capabilities.key)) && !(t.name === "browser" && !capabilities.state.browserEnabled), scope: ["write", "edit", "file_manage"].includes(t.name) ? (security.access === "full" ? "完全文件权限" : "当前工作区") : FILE_TOOLS.includes(t.name) ? "任意可读取目录" : "按工具配置" })), extensions: ["文件范围限制", "权限审批", "分层记忆", "学习画像", "联网与笔记工具"], mcp: mcp.snapshot(), terminal: "disabled" });
  send({type:"vault_overview",...vaultOverview.snapshot()});
  send({type:'vault_overview_config',selection:overviewSelection});
  emitSession();
}

async function handle(command) {
  const id = command.id;
  try {
    switch (command.type) {
      case "init": {
        const reusingSession=!!session;
        const remoteConfig = await endpoint.config();
        send({ type: "endpoint", config: remoteConfig, hasKey: await endpoint.loadKey().then(Boolean).catch(() => false) });
        if (!session) await openSession(command.provider || appState.provider || (remoteConfig ? REMOTE_PROVIDER : undefined), command.model || appState.modelId || remoteConfig?.modelId);
        await emitState();
        if(reusingSession)emitHistory();
        send({type:"session_sync",busy});
        send({ type: "ack", id });
        if(capabilities.state.vaultPath)void ensureOverview();
        break;
      }
      case "save_mcp":
      case "delete_mcp":
      case "discover_mcp": {
        if(busy)throw new Error("请等待当前任务完成");
        if(command.type==="save_mcp")await mcp.save(command);
        else if(command.type==="delete_mcp")await mcp.remove(command.serverId);
        else await mcp.discover(command.serverId);
        await emitState();send({type:"ack",id});break;
      }
      case "get_state":
        await emitState(); send({ type: "ack", id }); break;
      case "add_readonly": {
        if(busy)throw new Error("请等待当前任务结束");
        if(typeof command.path!=="string" || !command.path.trim())throw new Error("请选择目录");
        const path=await realpath(resolve(command.path));if(!(await stat(path)).isDirectory())throw new Error("请选择目录");
        security.readOnly ||= [];if(!security.readOnly.some(p=>p.toLowerCase()===path.toLowerCase()))security.readOnly.push(path);
        await userConfig.set("security",security);await emitState();send({type:"ack",id});break;
      }
      case "remove_readonly":
        if(busy)throw new Error("请等待当前任务结束");
        security.readOnly=(security.readOnly || []).filter(p=>p!==command.path);
        await userConfig.set("security",security);await emitState();send({type:"ack",id});break;
      case "set_approval":
        if (!["manual", "auto"].includes(command.mode)) throw new Error("无效的审批模式");
        security.approval = command.mode; await userConfig.set("security",security); await emitState(); send({ type: "ack", id }); break;
      case "set_file_access":
        if (!["workspace", "full"].includes(command.mode)) throw new Error("无效的文件权限范围");
        if (busy) throw new Error("请等待当前任务结束后切换文件范围");
        await mcp.closeAll();security.access = command.mode; await userConfig.set("security",security); await emitState(); send({ type: "ack", id }); break;
      case "queue_message": {
        if (!session || !busy) throw new Error("当前没有正在运行的任务，请直接发送消息");
        if (typeof command.text !== "string" || !command.text.trim()) throw new Error("消息不能为空");
        if (!["steer", "followUp"].includes(command.mode)) throw new Error("请选择引导或排队");
        await prepareSkills(command.text);
        await session[command.mode](command.text); send({ type: "queue", steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() }); send({ type: "ack", id }); break;
      }
      case "clear_queue":
        session?.clearQueue(); send({ type: "queue", steering: [], followUp: [] }); send({ type: "ack", id }); break;
      case "promote_queue": {
        if(!session || !busy)throw new Error("当前任务已结束，消息可能已开始执行");
        const followUp=session.getFollowUpMessages();
        if(!Number.isInteger(command.index) || followUp[command.index]!==command.text)throw new Error("队列已更新，请重试");
        const previous=session.clearQueue();const [target]=previous.followUp.splice(command.index,1);
        for(const text of previous.steering)await session.steer(text);
        await session.steer(target);
        for(const text of previous.followUp)await session.followUp(text);
        send({type:"queue",steering:session.getSteeringMessages(),followUp:session.getFollowUpMessages()});send({type:"ack",id});break;
      }
      case "get_goals": {
        const enabled=roles.current().learningGoalsEnabled===true;
        send({type:"goals",id,goal:enabled&&projectPath?await goals.read(projectPath):null,enabled});break;
      }
      case "save_goals": {
        if(!roles.current().learningGoalsEnabled)throw new Error("当前角色未启用学习目标");
        if(command.projectPath!==projectPath)throw new Error("项目已切换，草稿未写入，请重新打开目标");
        const goal=await goals.save(projectPath,command.body,command.revision);
        send({type:"goals",id,goal,enabled:roles.current().learningGoalsEnabled});break;
      }
      case "generate_vault_overview":
        if(!capabilities.state.vaultPath)throw new Error("请先连接笔记库");
        { const current=await getRuntime();
          const selected=command.providerId&&command.modelId?current.getModel(command.providerId,command.modelId):session?.model;
          if(providersPending)throw Error('模型配置已保存，等待当前模型任务结束后即可生成总览');
          if(!selected||selected.provider==='unknown')throw Error('请先选择总览生成模型');
          if(providers.providers.find(p=>p.id===selected.provider)?.models.find(m=>m.id===selected.id)?.enabled===false)throw Error('请勾选启用总览生成模型');
          const reasoning=command.reasoning||'off';
          if(!providers.modelInfo(selected.provider,selected.id,current).thinkingLevels.includes(reasoning))throw Error('此模型不支持选择的思考档位');
          void vaultOverview.start({model:selected,reasoning}).finally(flushProviders);send({type:'ack',id});break;
        }
      case "save_vault_overview_config": {
        const current=await getRuntime(),selected=current.getModel(command.providerId,command.modelId);
        if(!selected||providers.providers.find(p=>p.id===command.providerId)?.models.find(m=>m.id===command.modelId)?.enabled===false)throw Error('请选择已启用的总览模型');
        if(!providers.modelInfo(selected.provider,selected.id,current).thinkingLevels.includes(command.reasoning))throw Error('模型不支持此思考档位');
        const selection={providerId:command.providerId,modelId:command.modelId,reasoning:command.reasoning};
        await userConfig.set('vaultOverviewSelection',selection);overviewSelection=selection;send({type:'vault_overview_config',selection});send({type:'ack',id});break;
      }
      case "cancel_vault_overview":
        vaultOverview.cancel();vaultOverview.emit("idle",{message:"已停止生成，可以重新开始"});send({type:"ack",id});break;
      case "configure_capabilities":
      case "import_skill":
      case "toggle_skill": {
        if (busy) throw new Error("请等待当前回复结束");
        if (command.type === "configure_capabilities") {
          if(command.vaultPath){const target=await realpath(command.vaultPath);if(inside(target,dataDir)||inside(dataDir,target))throw new Error("笔记库不能与应用私有数据目录重叠");}
          await capabilities.configure(command);
          if(command.vaultPath!==undefined){vaultOverview.cancel();vaultOverview.emit("idle");}
        }
        if (command.type === "import_skill") await capabilities.importSkill(command.path);
        if (command.type === "toggle_skill") await capabilities.toggleSkill(command.skillId, command.enabled);
        const model = session?.model;
        if (session) await openSession(model?.provider === "unknown" ? undefined : model?.provider, model?.provider === "unknown" ? undefined : model?.id);
        await emitState(); send({ type: "ack", id });
        if(command.type==="configure_capabilities" && command.vaultPath)void ensureOverview();
        break;
      }
      case "search_notes":
        send({ type: "ack", id, results: await capabilities.searchNotes(command.query || "", 8) }); break;
      case "browse_notes":
        send({type:"ack",id,...await capabilities.browseNotes(command.offset)});break;
      case "skill_detail": {
        const skill = capabilities.state.skills.find(s => s.id === command.skillId);
        if (!skill) throw new Error("技能不存在");
        send({ type: "ack", id, text: (await readFile(join(skill.path, "SKILL.md"), "utf8")).slice(0, 100000) }); break;
      }
      case "resolve_file":
        send({ type: "ack", id, path: await capabilities.resolveFile(command.path, cwd) }); break;
      case "save_provider": {
        const saved = await providers.save(command);
        await providers.install(await providerRuntime());
        modelRequests.refresh();
        await emitState(); send({ type: "ack", id, providerId: saved.id, message:providersPending?'已保存，当前模型任务结束后生效':'提供商已保存' });
        break;
      }
      case "discover_models": {
        await providers.discover(command.providerId, await providerRuntime());
        await emitState(); send({ type: "ack", id });
        break;
      }
      case "refresh_model": {
        const info=await providers.refreshModel(command.providerId,command.modelId,await providerRuntime());
        await emitState();send({type:"ack",id,modelInfo:info});break;
      }
      case "delete_provider":
        if(busy)throw new Error("请等待当前回复结束");
        await providers.remove(command.providerId,await getRuntime());
        if(session?.model?.provider===command.providerId){delete appState.provider;delete appState.modelId;await openSession();}
        await emitState();send({type:"ack",id});break;
      case "update_model": {
        await providers.updateModel(command.providerId, command.model, await providerRuntime());
        if(!busy&&session?.model?.provider===command.providerId && session.model.id===command.model.id){const selected=(await getRuntime()).getModel(command.providerId,command.model.id);if(selected)await session.setModel(selected);else await openSession();}
        await emitState(); send({ type: "ack", id, message:providersPending?'模型信息已保存，当前模型任务结束后生效':'模型信息已保存' });
        break;
      }
      case "configure_remote": {
        if (busy) throw new Error("请先等待当前回复结束");
        validateEndpoint(command.baseUrl, command.modelId);
        if (command.key) await endpoint.saveKey(command.key);
        else if (!(await endpoint.loadKey())) throw new Error("请填写 API Key");
        const config = await endpoint.saveConfig(command.baseUrl, command.modelId);
        const models = await getRuntime();
        await models.refresh();
        await models.setRuntimeApiKey(REMOTE_PROVIDER, await endpoint.loadKey());
        const available = await models.getAvailable();
        send({ type: "models", models: available.map((model) => ({ provider: model.provider, id: model.id, name: model.name })) });
        await openSession(REMOTE_PROVIDER, config.modelId);
        send({ type: "endpoint", config, hasKey: true });
        send({ type: "ack", id });
        break;
      }
      case "memory_enabled":
        memoryAgent.cancel();
        await memory.setEnabled(command.layer, command.enabled);await userConfig.set("memoryEnabled",memory.state.enabled);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_profile":
        await memory.setProfile(command.profile);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_note_save":
        await memory.saveNote(command);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_note_delete":
        memoryAgent.cancel();
        await memory.deleteNote(command.noteId);
        send({ type: "memory", state: memory.snapshot() });
        send({ type: "ack", id });
        break;
      case "memory_work_delete":
        workingTools.cancel();await memory.deleteWork(command.title,command.workId);send({type:"memory",state:memory.snapshot()});send({type:"ack",id});break;
      case "draft_work_skill":
        send({type:'ack',id,draft:await memory.createWorkSkillDraft(command.workId,cwd)});break;
      case "memory_fact_delete":
        memoryAgent.cancel(); await memory.deleteFact(command.key);
        send({ type: "memory", state: memory.snapshot() }); send({ type: "ack", id }); break;
      case "memory_consolidate":
          if(!roles.current().learnerProfileEnabled)throw new Error("当前角色已关闭学习者画像与记忆功能");
          if (busy) throw new Error("请等待当前回复结束");
          if (!session?.model || session.model.provider === "unknown") throw new Error("请先配置并选择模型");
          if (!session.state.messages.some(message => message.role === "user")) throw new Error("请先进行对话，再整理记忆");
          if (!memory.state.enabled.l1 && !memory.state.enabled.l2) throw new Error("请先开启画像或知识库记忆");
        memoryAgent.cancel(); void memoryAgent.consolidate(); send({ type: "ack", id }); break;
      case "save_role": {
        if (busy) throw new Error("请先等待当前回复结束");
        if(command.skills?.some(b=>!capabilities.state.skills.some(s=>s.id===b.skillId))) throw new Error("找不到绑定的技能，请刷新技能仓库");
        const roleId = await roles.save(command);
        if (roleId === roles.activeId) {
          const model = session?.model;
          await openSession(model?.provider === "unknown" ? undefined : model?.provider,
            model?.provider === "unknown" ? undefined : model?.id);
        }
        send({ type: "roles", ...roles.list() });
        send({ type: "ack", id });
        break;
      }
      case "select_role": {
        if (busy) throw new Error("请先等待当前回复结束");
        await roles.select(command.roleId);
        const model = session?.model;
        await openSession(model?.provider === "unknown" ? undefined : model?.provider,
          model?.provider === "unknown" ? undefined : model?.id,
          SessionManager.create(cwd, sessionsDir));
        send({ type: "roles", ...roles.list() });
        send({ type: "ack", id });
        break;
      }
      case "delete_role": {
        if (busy) throw new Error("请先等待当前回复结束");
        const wasActive = roles.activeId === command.roleId;
        await roles.delete(command.roleId);
        if (wasActive) {
          const model = session?.model;
          await openSession(model?.provider === "unknown" ? undefined : model?.provider,
            model?.provider === "unknown" ? undefined : model?.id,
            SessionManager.create(cwd, sessionsDir));
        }
        send({ type: "roles", ...roles.list() });
        send({ type: "ack", id });
        break;
      }
      case "set_key": {
        if (!command.provider || !command.key) throw new Error("Provider and API key are required");
        await (await getRuntime()).setRuntimeApiKey(command.provider, command.key);
        send({ type: "ack", id });
        break;
      }
      case "select_model": {
        if (busy) throw new Error("Wait for the current response to finish");
        if(providers.providers.find(p=>p.id===command.provider)?.models.find(m=>m.id===command.model)?.enabled===false)throw Error('该模型尚未勾选启用');
        const info=providers.modelInfo(command.provider,command.model,await getRuntime());
        if(command.thinkingLevel!==undefined && !info.thinkingLevels.includes(command.thinkingLevel))throw new Error("该模型不支持此思考选项");
        await openSession(command.provider, command.model);
        if(command.thinkingLevel!==undefined){session.setThinkingLevel(command.thinkingLevel,{persist:true});emitSession();}
        send({ type: "ack", id });
        // 笔记库已连接但总览还没生成时，模型一旦就绪就补上。
        // 总览文件已存在时 ensure() 会直接返回，不会重复调用模型。
        if(capabilities.state.vaultPath)void ensureOverview();
        break;
      }
      case "set_thinking_level": {
        if (busy) throw new Error("请先等待当前回复结束");
        if (!session) throw new Error("会话尚未就绪");
        if (!thinkingLevels().includes(command.level)) throw new Error("该模型不支持此思考深度");
        session.setThinkingLevel(command.level, { persist: true });
        send({ type: "thinking_level", level: session.thinkingLevel, availableThinkingLevels: thinkingLevels(), ...thinkingInfo() });
        send({ type: "ack", id });
        break;
      }
      case "rename_session": {
        if (busy) throw new Error("请先等待当前回复结束");
        if (!session) throw new Error("会话尚未就绪");
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name || name.length > 100) throw new Error("请输入不超过 100 字的会话名称");
        session.setSessionName(name);
        send({ type: "session_name", sessionId: session.sessionId, name });
        send({ type: "ack", id });
        break;
      }
      case "copy_session": {
        if (!session) throw new Error("会话尚未就绪");
        const lines = [];
        for (const message of session.state.messages) {
          if (message.role !== "user" && message.role !== "assistant") continue;
          const content = typeof message.content === "string" ? message.content :
            (message.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("\n");
          if (content.trim()) lines.push(`${message.role === "user" ? "你" : "PI"}：${content.trim()}`);
        }
        send({ type: "conversation", id, text: lines.join("\n\n") });
        break;
      }
      case "stage_file": {
        if (!session) await openSession();
        const file = await stageFile(dataDir, session.sessionId, command.name, command.data);
        send({ type: "file_staged", id, ...file });
        break;
      }
      case "change_workspace": {
        if (busy) throw new Error("Wait for the current response to finish");
        if (typeof command.path !== "string" || !command.path.trim()) throw new Error("Choose a workspace folder");
        const next = resolve(command.path.trim());
        if (!(await stat(next)).isDirectory()) throw new Error("Workspace path is not a folder");
        const previous = cwd;
        const previousProject = projectPath;
        const model = session?.model;
        cwd = next;
        projectPath = next;
        try {
          await openSession(model?.provider === "unknown" ? undefined : model?.provider, model?.provider === "unknown" ? undefined : model?.id, SessionManager.create(cwd, sessionsDir));
        } catch (error) {
          cwd = previous;
          projectPath = previousProject;
          throw error;
        }
        send({ type: "ack", id });
        break;
      }
      case "list_sessions": {
        const sessions = await SessionManager.listAll(sessionsDir);
        send({ type: "sessions", id, sessions: sessions.map((item) => ({
          id: item.id,
          title: item.name || item.firstMessage || "新会话",
          modified: item.modified,
          messageCount: item.messageCount,
          archived: !!metadata[item.id]?.archived,
          projectPath: metadata[item.id] ? metadata[item.id].projectPath : ((item.cwd === neutralWorkspace || item.cwd === process.env.SUMMON_WORKSPACE) ? null : item.cwd),
        })) });
        break;
      }
      case "compact": {
        if(busy || !session) throw new Error("请等待当前任务完成");
        busy=true;send({type:"compaction",status:"running",enabled:session.autoCompactionEnabled});
        try { await session.compact(); emitTelemetry();send({type:"compaction",status:"done",enabled:session.autoCompactionEnabled});send({type:"ack",id}); }
        catch(e){if(e.message?.includes("Nothing to compact")){send({type:"compaction",status:"skipped",message:"当前会话较短，无需压缩；自动压缩仍保持开启",enabled:session.autoCompactionEnabled});send({type:"ack",id,skipped:true});}else{send({type:"compaction",status:"error",message:e.message,enabled:session.autoCompactionEnabled});throw e;}}
        finally{busy=false;}break;
      }
      case "archive_session":
      case "delete_session": {
        if(busy)throw new Error("请等待当前任务完成");
        const info=(await SessionManager.listAll(sessionsDir)).find(item=>item.id===command.sessionId);
        if(!info)throw new Error("找不到该会话");
        if(command.type==="delete_session" && command.confirm!==true)throw new Error("删除需要确认");
        if(info.id===session?.sessionId){const model=session.model;await openSession(model?.provider,model?.id,SessionManager.create(cwd,sessionsDir));}
        if(command.type==="delete_session"){await unlink(info.path);delete metadata[info.id];}
        else metadata[info.id]={...metadata[info.id],archived:command.archived!==false};
        await saveJson(metadataPath,metadata);send({type:"ack",id});break;
      }
      case "new_session": {
        if (busy) throw new Error("Wait for the current response to finish");
        const model = session?.model;
        if (command.noProject) { projectPath = null; cwd = neutralWorkspace; }
        await openSession(model?.provider === "unknown" ? undefined : model?.provider,
          model?.provider === "unknown" ? undefined : model?.id,
          SessionManager.create(cwd, sessionsDir));
        send({ type: "ack", id });
        break;
      }
      case "open_session": {
        if (busy) throw new Error("Wait for the current response to finish");
        if (typeof command.sessionId !== "string") throw new Error("Session ID is required");
        const info = (await SessionManager.listAll(sessionsDir)).find((item) => item.id === command.sessionId);
        if (!info) throw new Error("找不到该会话");
        projectPath = metadata[info.id] ? metadata[info.id].projectPath : ((info.cwd === neutralWorkspace || info.cwd === process.env.SUMMON_WORKSPACE) ? null : info.cwd);
        cwd = projectPath || neutralWorkspace;
        await openSession(undefined, undefined, SessionManager.open(info.path, sessionsDir, cwd));
        send({ type: "ack", id });
        break;
      }
      case "prompt":
        if (busy) throw new Error("A response is already running");
        if (!session) await openSession();
        if (!session.model || session.model.provider === "unknown") throw new Error("Configure an API key and select a model first");
        if(providers.providers.find(p=>p.id===session.model.provider)?.models.find(m=>m.id===session.model.id)?.enabled===false)throw Error('当前模型已取消勾选，请选择一个已启用模型');
        if (typeof command.text !== "string") throw new Error("消息文字无效");
        const images = normalizeImages(command.images);
        if(images.length && !session.model.input?.includes("image"))throw new Error("当前模型未启用视觉能力。请在设置 → 模型中启用支持图片，再重新发送。");
        if (!command.text.trim() && !images.length) throw new Error("请输入消息或添加图片");
        busy = true;
        const controller = new AbortController();turnController=controller;
        turnRecovery.begin();
        visualReview.begin(command.text);
        outputTokens = 0; generationMs = 0; missingUsage = false;
        memoryAgent.cancel();
        send({ type: "started", id });
        let completedOutcome;
        try {
          await applyProviders();
          await prepareSkills(command.text);controller.signal.throwIfAborted();
          await contextPolicy.preparePrompt(command.text, images);
          controller.signal.throwIfAborted();
          await session.prompt(command.text, { images });
          emitTelemetry();
          const outcome = controller.signal.aborted?{status:'aborted',message:'用户已停止回复'}:visualReview.outcome(turnRecovery.outcome());
          if (visualReview.snapshot().required) {
            const lastAssistant = session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
            if (lastAssistant) session.sessionManager.appendCustomEntry("reed_turn_verification", { messageEntryId: lastAssistant.id, outcome, review: visualReview.snapshot() });
          }
          completedOutcome=outcome;
        } catch(error) {
          if(controller.signal.aborted)completedOutcome={status:'aborted',message:'用户已停止回复'};
          else throw error;
        } finally {
          turnRecovery.end();
          if(turnController===controller)turnController=null;
          try{while(providersPending&&!vaultOverview.running)await applyProviders();if(providersPending===false)await emitState();}
          finally{busy=false;}
          send({type:'session_sync',busy:false});
        }
        send({type:'done',id,outcome:completedOutcome});
        if(completedOutcome?.status==='complete'){memoryAgent.schedule();void workingTools.consolidate();}
        break;
      case "abort":
        turnController?.abort(new DOMException('用户已停止回复','AbortError'));
        turnRecovery.end();
        approvalGate.cancel("用户停止了当前操作");
        if (session) void session.abort().catch(error=>send({type:'error',message:error.message}));
        send({type:'stopping'});
        send({ type: "ack", id });
        break;
      case "tool_decision": {
        approvalGate.decide(command.requestId, command.decision, command.reason);
        send({ type: "ack", id });
        break;
      }
      default:
        throw new Error(`Unknown command: ${command.type}`);
    }
  } catch (error) {
    send({ type: "error", id, commandType:command.type, message: error instanceof Error ? error.message : String(error) });
  }
}

send({ type: "ready" });
for await (const line of createInterface({ input: process.stdin })) {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    send({ type: "error", message: "Invalid JSON command" });
    continue;
  }
  if ((command.type === "init" && session) || ["get_goals", "save_goals", "cancel_vault_overview", "abort", "tool_decision", "queue_message", "promote_queue", "clear_queue", "set_approval"].includes(command.type)) {
    void handle(command);
  } else if(command.type==='prompt') {
    // Do not hold the settings/read command queue for an entire agent turn.
    queue = queue.then(()=>{if(busy||applyingProviders){send({type:'error',id:command.id,message:'当前任务或配置仍在结束，请稍后重试。'});return;}activePrompt=handle(command);});
  } else {
    queue = queue.then(() => handle(command));
  }
}
await queue;turnController?.abort();if(session)void session.abort();await activePrompt;vaultOverview.cancel();await mcp.closeAll();
memoryAgent.cancel();
workingTools.cancel();
capabilities.close();
learningTools.close();
session?.dispose();
approvalGate.cancel("Agent 进程已退出");
