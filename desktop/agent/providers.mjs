import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { protectKey, unprotectKey, EndpointStore } from "./endpoint.mjs";

const presets = [
  { id: "deepseek", name: "DeepSeek", sdk: "deepseek", protocol: "openai-completions", baseUrl: "https://api.deepseek.com" },
  { id: "kimi", name: "Kimi", sdk: "moonshotai-cn", protocol: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "minimax", name: "MiniMax", sdk: "minimax", protocol: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
  { id: "doubao", name: "火山引擎", sdk: "volcengine", protocol: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "mimo", name: "小米 MiMo", sdk: "xiaomi", protocol: "openai-completions", baseUrl: "https://api.xiaomimimo.com/v1" },
  { id: "qwen", name: "阿里百炼", sdk: "qwen-token-plan-cn", protocol: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "openai", name: "OpenAI", sdk: "openai", protocol: "openai-completions", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", sdk: "anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
  { id: "custom", name: "自定义", sdk: null, protocol: "openai-completions", baseUrl: "" },
];
const positive = (...values) => values.find((value) => Number.isFinite(Number(value)) && Number(value) > 0) ? Number(values.find((value) => Number.isFinite(Number(value)) && Number(value) > 0)) : null;
const defaultThinkingLevels = ["off", "low", "medium", "high", "xhigh"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function configuredThinkingLevels(model) {
  if (model.reasoning === false) return ["off"];
  return model.thinkingLevels?.length ? model.thinkingLevels : defaultThinkingLevels;
}

async function fetchProviderModels(provider, request) {
  const headers = provider.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01", "x-api-key": request.key || "" } : { Authorization: `Bearer ${request.key || "no-key"}` };
  let response;
  try {
    response = await request.fetch(`${provider.baseUrl}/models`, { headers, signal: AbortSignal.timeout(12000) });
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") throw new Error("连接模型服务超时，请检查网络或服务状态");
    throw new Error("连接模型服务失败，请检查网络、Base URL 和服务状态");
  }
  if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}），请检查地址和凭据`);
  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") throw new Error("读取模型列表超时，请检查网络或服务状态");
    throw new Error("模型服务返回内容无法解析，请检查 Base URL 和服务状态");
  }
  return Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
}

export function normalizeDiscoveredModel(raw, known) {
  const id = String(raw.id || raw.name || "").trim();
  if (!id || id.length > 200) return null;
  const contextWindow = positive(raw.context_window, raw.context_length, raw.max_model_len, raw.max_input_tokens, raw.metadata?.context_window, known?.contextWindow);
  const explicitReasoning = raw.reasoning ?? raw.supports_reasoning ?? raw.capabilities?.reasoning;
  const levels = raw.thinking_levels || raw.reasoning_efforts || raw.supported_reasoning_efforts || raw.metadata?.reasoning_efforts;
  let thinkingLevels = Array.isArray(levels) ? [...new Set(["off", ...levels.filter(level => ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))])] : null;
  const format = raw.thinking_format || raw.compat?.thinkingFormat;
  if (["qwen","qwen-chat-template"].includes(format)) thinkingLevels=["off","medium"];
  const reasoning = typeof explicitReasoning === "boolean" ? explicitReasoning : thinkingLevels?.some(level => level !== "off") ? true : known?.reasoning ?? null;
  const compat = ["openai", "qwen", "qwen-chat-template", "deepseek"].includes(format) ? { ...known?.compat, thinkingFormat: format, supportsReasoningEffort: format === "openai" } : known?.compat;
  const modalities=raw.input || raw.input_modalities || raw.capabilities?.input;
  const vision=raw.supports_vision ?? raw.capabilities?.vision;
  const input=Array.isArray(modalities)?["text",...(modalities.includes("image")?["image"]:[])]:typeof vision==="boolean"?["text",...(vision?["image"]:[])]:known?.input||["text"];
  const maxTokens = positive(raw.max_output_tokens, raw.max_completion_tokens, raw.max_tokens, raw.limit?.output, raw.metadata?.max_output_tokens, raw.metadata?.max_completion_tokens, raw.metadata?.max_tokens, raw.metadata?.limit?.output, known?.maxTokens);
  return { id, name: raw.name || known?.name || id, contextWindow, maxTokens, reasoning, thinkingLevels, input, compat, infoSource: contextWindow || maxTokens || reasoning !== null ? (known ? "catalog+service" : "service") : "unknown" };
}

export class ProviderStore {
  constructor(directory, { protect = protectKey, unprotect = unprotectKey, request = fetch, config = null } = {}) {
    this.directory = directory; this.config=config;
    this.path = join(directory, "providers.json");
    this.modelsPath = join(directory, "models.json");
    this.providers = [];
    this.keys = new Map();
    this.saveTails = new Map();
    this.installTail = Promise.resolve();
    this.protect = protect; this.unprotect = unprotect; this.request = request;
  }
  async load() {
    try { const data = this.config ? await this.config.get("providers",this.path,null) : JSON.parse(await readFile(this.path, "utf8")); if(!data)throw Object.assign(new Error("legacy config"),{code:"ENOENT"}); this.providers = Array.isArray(data.providers) ? data.providers : []; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const legacy = new EndpointStore(this.directory);
      const config = await legacy.config();
      if (config) {
        this.providers.push({ id: "summon-remote", name: "自定义", template: "custom", baseUrl: config.baseUrl, protocol: "openai-completions", models: [normalizeDiscoveredModel({ id: config.modelId })] });
        const key = await legacy.loadKey().catch(() => "");
        if (key) await this.saveKey("summon-remote", key);
        await this.persist();
      }
    }
    for (const provider of this.providers) {
      try { this.keys.set(provider.id, await this.unprotect(await this.encryptedKey(provider.id))); }
      catch (error) { if (error.code !== "ENOENT") provider.credentialError = "凭据无法读取，请重新输入"; }
    }
  }
  async encryptedKey(id){const data=this.config?await this.config.read():{};if(data.credentials?.[id])return data.credentials[id];const old=await readFile(join(this.directory,`${id}.dpapi`),"utf8");if(this.config)await this.config.update(d=>{d.credentials||={};d.credentials[id]=old;});return old;}
  templates(runtime) {
    const catalog = runtime.getModels();
    return presets.map((preset) => {
      const known = catalog.find((model) => model.provider === preset.sdk && model.api === preset.protocol);
      return { ...preset, baseUrl: preset.baseUrl || known?.baseUrl || "" };
    });
  }
  snapshot() { return this.providers.map((provider) => ({ ...provider, hasKey: Boolean(this.keys.get(provider.id)) })); }
  async persist() { if(this.config){await this.config.set("providers",{providers:this.providers});return;} const temporary = `${this.path}.tmp`; await writeFile(temporary, JSON.stringify({ providers: this.providers }, null, 2)); await rename(temporary, this.path); }
  async saveKey(id, key) {
    if (typeof key !== "string" || key.length > 4096) throw new Error("API Key 无效");
    if(this.config){const encrypted=await this.protect(key);await this.config.update(d=>{d.credentials||={};d.credentials[id]=encrypted;});this.keys.set(id,key);return;}
    const temporary = join(this.directory, `${id}.dpapi.tmp`);
    await writeFile(temporary, await this.protect(key)); await rename(temporary, join(this.directory, `${id}.dpapi`));
    this.keys.set(id, key);
  }
  async save(input) {
    const requestId = input.clientRequestId;
    if (requestId != null && (typeof requestId !== "string" || !uuidPattern.test(requestId))) throw new Error("提供商草稿标识无效，请重新打开新增表单");
    if (!requestId) return this.saveRecord(input);
    const previous = this.saveTails.get(requestId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.saveTails.set(requestId, current);
    await previous;
    try { return await this.saveRecord(input); }
    finally { release(); if (this.saveTails.get(requestId) === current) this.saveTails.delete(requestId); }
  }
  async saveRecord(input) {
    const template = presets.find((item) => item.id === input.template);
    if (!template) throw new Error("请选择提供商");
    let url;
    try { url = new URL(input.baseUrl.trim()); } catch { throw new Error("请填写有效的 Base URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Base URL 格式无效");
    if (!["openai-completions", "anthropic-messages"].includes(input.protocol)) throw new Error("不支持该接口协议");
    const normalizedBaseUrl = url.href.replace(/\/$/, "");
    let provider = input.providerId ? this.providers.find((item) => item.id === input.providerId) : null;
    if (input.clientRequestId) {
      const draftProvider = this.providers.find((item) => item.clientRequestId === input.clientRequestId);
      if (provider && draftProvider && provider.id !== draftProvider.id) throw new Error("提供商草稿标识与配置不匹配");
      if (provider && provider.clientRequestId && provider.clientRequestId !== input.clientRequestId) throw new Error("提供商草稿标识与配置不匹配");
      provider ||= draftProvider;
    }
    if (input.providerId && !provider) throw new Error("找不到该提供商");
    if (input.parallelRequests !== undefined && typeof input.parallelRequests !== 'boolean') throw new Error('并行请求设置无效');
    const parallelRequests = input.parallelRequests ?? provider?.parallelRequests ?? false;
    const maxConcurrentRequests = input.maxConcurrentRequests !== undefined ? input.maxConcurrentRequests : provider?.maxConcurrentRequests ?? 2;
    if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 2 || maxConcurrentRequests > 8) throw new Error('最大并发数须为2到8的整数');
    const record = provider || { id: `summon-${randomUUID()}`, models: [] };
    if (input.key?.trim()) await this.saveKey(record.id, input.key.trim());
    const endpointChanged = record.baseUrl && (record.baseUrl !== normalizedBaseUrl || record.protocol !== input.protocol);
    if (endpointChanged) record.models = [];
    Object.assign(record, { name: String(input.name || template.name).slice(0, 60), template: template.id, protocol: input.protocol, parallelRequests, maxConcurrentRequests, baseUrl: normalizedBaseUrl, ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) });
    delete record.credentialError;
    if (!provider) this.providers.push(record);
    await this.persist(); return record;
  }
  async discover(providerId, runtime) {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("请先保存提供商");
    const list = await fetchProviderModels(provider, { fetch: this.request, key: this.keys.get(provider.id) });
    const preset = presets.find((item) => item.id === provider.template);
    const catalog = runtime.getModels().filter((model) => model.provider === preset?.sdk);
    const previous=provider.models;
    provider.models = list.map((raw) => {const model=normalizeDiscoveredModel(raw,catalog.find(m=>m.id===raw.id));const old=previous.find(m=>m.id===model?.id);const overrides=old?.overrides;return model && {...model,enabled:old?old.enabled:false,...overrides,...(overrides?{overrides,infoSource:"user"}:{})};}).filter(Boolean).slice(0, 300);
    if (!provider.models.length) throw new Error("接口未返回模型，请检查 Base URL 是否包含正确的 API 路径");
    await this.persist(); await this.install(runtime); return provider.models;
  }
  async refreshModel(providerId, id, runtime) {
    const provider=this.providers.find(p=>p.id===providerId);
    if(!provider) throw new Error("找不到该提供商");
    const list=await fetchProviderModels(provider,{fetch:this.request,key:this.keys.get(provider.id)});
    const raw=list.find(m=>(m.id||m.name)===id);
    if(!raw) throw new Error("服务未返回此模型，请刷新模型列表");
    const preset=presets.find(p=>p.id===provider.template);
    const model=normalizeDiscoveredModel(raw,runtime.getModels().find(m=>m.provider===preset?.sdk && m.id===id));
    const index=provider.models.findIndex(m=>m.id===id);
    const previous=provider.models[index];if(previous)model.enabled=previous.enabled;
    const overrides=previous?.overrides;if(overrides)Object.assign(model,overrides,{overrides,infoSource:"user"});
    if(index<0)provider.models.push(model);else provider.models[index]=model;
    await this.persist();await this.install(runtime);return this.modelInfo(providerId,id,runtime);
  }
  async remove(id,runtime) {
    const index=this.providers.findIndex(p=>p.id===id);
    if(index<0)throw new Error("找不到该提供商");
    this.providers.splice(index,1);await this.persist();this.keys.delete(id); if(this.config)await this.config.update(d=>{if(d.credentials)delete d.credentials[id];});
    await unlink(join(this.directory,`${id}.dpapi`)).catch(e=>{if(e.code!=="ENOENT")throw e;});
    const config=await readFile(this.modelsPath,"utf8").then(JSON.parse).catch(e=>{if(e.code==="ENOENT")return{};throw e;});
    if(config.providers)delete config.providers[id];
    await writeFile(this.modelsPath,JSON.stringify(config,null,2));await this.install(runtime);
    await runtime.setRuntimeApiKey(id,"");
  }
  async updateModel(providerId, input, runtime) {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error("找不到该提供商");
    if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0)) throw new Error("最大输出长度必须是正整数");
    let model = provider.models.find((item) => item.id === input.id);
    if (!model) { model = normalizeDiscoveredModel({ id: input.id }); if (!model) throw new Error("Model ID 无效"); provider.models.push(model); }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw new Error("模型启用设置无效");
      model.enabled = input.enabled;
    }
    if (input.contextWindow !== undefined) model.contextWindow = positive(input.contextWindow);
    if (input.maxTokens !== undefined) model.maxTokens = input.maxTokens;
    if (typeof input.vision === "boolean") model.input=["text",...(input.vision?["image"]:[])];
    if (typeof input.reasoning === "boolean") model.reasoning = input.reasoning;
    const previousFormat=model.compat?.thinkingFormat;
    if (input.thinkingFormat) {
      model.reasoning = true;
      if (!["openai", "qwen", "qwen-chat-template", "deepseek"].includes(input.thinkingFormat)) throw new Error("思考协议无效");
      model.compat = { ...model.compat, thinkingFormat: input.thinkingFormat, supportsReasoningEffort: input.thinkingFormat === "openai" };
      if (["qwen", "qwen-chat-template"].includes(input.thinkingFormat)) model.thinkingLevels = ["off", "medium"];
      else if (["qwen", "qwen-chat-template"].includes(previousFormat) && input.thinkingFormat === "openai") model.thinkingLevels = [...defaultThinkingLevels];
    }
    if (Array.isArray(input.thinkingLevels) && input.thinkingLevels.length && !["qwen", "qwen-chat-template"].includes(model.compat?.thinkingFormat)) {
      if (input.thinkingLevels.some(level => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))) throw new Error("思考档位无效");
      model.thinkingLevels = [...new Set(["off", ...input.thinkingLevels])]; model.reasoning = true;
    }
    if(typeof input.reasoning==="boolean")model.reasoning=input.reasoning;
    model.overrides={...model.overrides};
    for(const key of ["contextWindow","maxTokens","reasoning","thinkingLevels","compat"])if(input[key]!==undefined || (["compat","thinkingLevels"].includes(key)&&input.thinkingFormat))model.overrides[key]=model[key];
    if(typeof input.vision==="boolean")model.overrides.input=model.input;
    model.infoSource = "user";
    await this.persist(); await this.install(runtime);
  }
  install(runtime) {
    const operation = this.installTail.then(() => this.installNow(runtime));
    this.installTail = operation.catch(() => {});
    return operation;
  }
  async installNow(runtime) {
    let current = {};
    try { current = JSON.parse(await readFile(this.modelsPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    current.providers ||= {};
    for (const provider of this.providers) {
      if (!provider.models.length) { delete current.providers[provider.id]; continue; }
      const enabledModels = provider.models.filter((model) => model.enabled !== false);
      if (!enabledModels.length) { delete current.providers[provider.id]; continue; }
      current.providers[provider.id] = { baseUrl: provider.baseUrl, api: provider.protocol, models: enabledModels.map((model) => {
        const levels=configuredThinkingLevels(model);
        const compat=model.reasoning==null && provider.protocol==="openai-completions" && !model.compat?.thinkingFormat ? {...model.compat,thinkingFormat:"openai",supportsReasoningEffort:true} : model.compat;
        return { id:model.id,name:model.name,...(model.contextWindow?{contextWindow:model.contextWindow}:{}),...(model.maxTokens?{maxTokens:model.maxTokens}:{}),reasoning:model.reasoning!==false,input:model.input||["text"],...(compat?{compat}:{}),thinkingLevelMap:Object.fromEntries(["minimal","low","medium","high","xhigh","max"].map(level=>[level,levels.includes(level)?level:null])) };
      }) };
    }
    const temporary = `${this.modelsPath}.tmp`; await writeFile(temporary, JSON.stringify(current, null, 2)); await rename(temporary, this.modelsPath);
    await runtime.refresh();
    for (const provider of this.providers) await runtime.setRuntimeApiKey(provider.id, this.keys.get(provider.id) || "no-key");
  }
  modelInfo(providerId, id, runtime) {
    const stored = this.providers.find((item) => item.id === providerId)?.models.find((item) => item.id === id);
    const model = runtime.getModel(providerId, id);
    const levels = model ? getSupportedThinkingLevels(model) : ["off"];
    return { contextWindow: model?.contextWindow, reasoning: model?.reasoning, ...stored, maxTokens:model?.maxTokens ?? stored?.maxTokens, compat:model?.compat || stored?.compat, provider: providerId, providerName: this.providers.find(item => item.id === providerId)?.name || providerId, thinkingDefaults:!!stored && stored.reasoning!==false && !stored.thinkingLevels?.length, thinkingLevels: stored ? configuredThinkingLevels(stored).filter(level=>levels.includes(level)) : levels };
  }
}
