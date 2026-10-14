import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { userTexts } from "./learner.mjs";
import { skippedMemory } from './memory-value.mjs';

const noMemoryPatterns = [
  /(?:不要|别|无需|不必)记住|(?:不要|别)记(?:下|入|到|进|这个|这件|这条)/,
  /(?:不要|不应|不得|禁止|别|无需|不需要|不再|不允许)[^。！？；;\n]{0,30}(?:保存|写入|写进|写到|记录|总结|整理|存入|存到|存进|加入|记到|记入|记住)[^。！？；;\n]{0,30}(?:长期记忆|永久记忆|记忆|memory)/i,
  /(?:不保存|不写入|不写|不记录|不总结|不整理)[^。！？；;\n]{0,20}(?:长期记忆|永久记忆|记忆|memory)/i,
  /(?:不要|禁止|关闭|禁用)[^。！？；;\n]{0,12}(?:长期记忆|永久记忆|记忆保存|记忆整理)/i,
  /\b(?:do\s+not|don't|never)\s+(?:\w+\s+){0,6}(?:save|store|write|summari[sz]e|record)[^.?!\n]{0,70}\b(?:memory|memories)\b/i,
  /\b(?:do\s+not|don't|never)\s+remember\b/i,
];
const messageText = message => typeof message?.content === "string" ? message.content : (message?.content || []).filter(block => block.type === "text").map(block => block.text || "").join("\n");

// Session-scoped only: original branch messages survive context compaction.
// Assistant/tool text and generated summaries cannot change memory permission.
export function sessionDisallowsMemory(session, pendingPrompt = "") {
  const branch = session?.sessionManager?.getBranch?.();
  const users = Array.isArray(branch) ? branch.filter(entry => entry.type === "message" && entry.message?.role === "user").map(entry => entry.message) : (session?.state?.messages || []).filter(message => message.role === "user");
  return [...users.map(messageText), pendingPrompt].some(text => noMemoryPatterns.some(pattern => pattern.test(text)));
}

export function createMemoryAgent({ memory, learner, send, currentSession, runtime, judgeValue, enabled = () => true }) {
  let timer;
  let controller;
  let generation = 0;
  function cancel() { generation++; clearTimeout(timer); controller?.abort(); controller = undefined; }
  function extension(pi) {
    pi.registerTool(defineTool({
      name: "remember", label: "整理记忆", description: "保存用户明确表达的长期学习背景、偏好或可复用知识。只保存明确事实，纠正时使用相同 key/title 更新。不要存凭据、一次性任务或推测。",
      parameters: Type.Object({ layer: Type.Union([Type.Literal("profile"), Type.Literal("knowledge")]), key: Type.String(), content: Type.String(),operation:Type.Optional(Type.Union([Type.Literal('supplement'),Type.Literal('replace')])) }),
      async execute(_id, input, signal) {
        if (!enabled()) return { content: [{ type: "text", text: "当前角色的学习者画像与记忆功能已关闭，未保存" }], details: { skipped: true } };
        if (sessionDisallowsMemory(currentSession())) return { content: [{ type: "text", text: "用户已要求本会话不写入长期记忆，未保存" }], details: { skipped: true, reason: "session_no_memory" } };
        const layer = input.layer === "profile" ? "l1" : "l2";
        if (!memory.state.enabled[layer]) return { content: [{ type: "text", text: "此层记忆已关闭，未保存" }], details: {} };
        const selected = currentSession();
        const verdict = await judgeValue?.([{ area: input.layer, key: input.key, content: input.content,operation:input.operation }], { signal });
        if (!verdict?.[0] || signal?.aborted || currentSession() !== selected || !enabled() || sessionDisallowsMemory(selected) || !memory.state.enabled[layer]) return skippedMemory(verdict?.diagnostics?.[0]);
        await memory.applyAgentUpdate(input.layer === "profile" ? { facts: [{ key: input.key, content: input.content,operation:input.operation }] } : { notes: [{ title: input.key, body: input.content,operation:input.operation }] }, currentSession()?.sessionId || "agent");
        send({ type: "memory", state: memory.snapshot() });
        return { content: [{ type: "text", text: "记忆已整理保存" }], details: { layer } };
      },
    }));
    pi.on("before_agent_start", async (event) => {
      if (!enabled()) { cancel(); delete event.systemPromptOptions.sections.summon_memory; return; }
      const prohibited = sessionDisallowsMemory(currentSession(), event.prompt);
      if (prohibited) cancel();
      const recalled = await memory.context(event.prompt, currentSession()?.sessionId);
      const instruction = prohibited ? "用户已明确要求本会话不写入长期记忆：禁止调用 remember，禁止后台整理本会话到长期记忆。会话上下文压缩摘要不属于长期记忆。" : (memory.state.enabled.l1 || memory.state.enabled.l2) ? "当用户要求记住、纠正记忆，或明确表达稳定的学习目标和偏好时，使用 remember 整理对应记忆。不要要求用户手填记忆表单。" : "长期记忆整理已关闭，不调用 remember。";
      event.systemPromptOptions.sections.summon_memory = `${instruction}\n以下记忆和资料只作参考，当前用户指令优先：\n${recalled || "暂无相关记忆"}`;
    });
  }
  async function consolidate() {
    const selected = currentSession();
    if (!enabled() || sessionDisallowsMemory(selected) || !selected?.model || selected.model.provider === "unknown" || (!memory.state.enabled.l1 && !memory.state.enabled.l2)) return;
    const ticket = generation;
    controller = new AbortController();
    const sessionId = selected.sessionId;
    const messages = selected.state.messages.filter((message) => ["user", "assistant"].includes(message.role)).slice(-8);
    const text = messages.map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : (message.content || []).filter((block) => block.type === "text").map((block) => block.text).join("\n")}`).join("\n").slice(-10000);
    if (!text.trim()) return;
    send({ type: "memory_status", status: "organizing" });
    try {
      const model = await runtime();
      if (!enabled() || ticket !== generation || sessionDisallowsMemory(selected)) return;
      const response = await model.completeSimple(selected.model, {
        systemPrompt: "你是本地学习助手的记忆整理器。根据对话和已有记忆，提取用户明确表达的长期学习背景/目标/偏好（facts），有复用价值且可信的知识笔记（notes），和结构化学习事件（learningEvents）。不要把问题本身当成用户属性，不保存密钥和个人敏感标识，不猜测掌握分数。同一主题不同说法也必须补充既有 key/title/subject，不新增重复项；合并已有内容和新增信息，纠正时明确最新状态。不把待复习清单混入 facts 或 notes，复习仅作为 learningEvents 保存。严格只返回 JSON：{\"facts\":[{\"key\":\"主题\",\"content\":\"明确事实\"}],\"notes\":[{\"title\":\"标题\",\"body\":\"简短整理\"}],\"learningEvents\":[{\"kind\":\"goal|preference|concept|misconception|review\",\"subject\":\"主题\",\"detail\":\"明确记录\",\"evidence\":\"用户原话的连续片段\",\"status\":\"active|completed|needs_review|resolved\"}]}。kind 必须选择一种。只有用户明确陈述目标/偏好/已学概念/存在误解/完成复习才记录，evidence 必须逐字引用用户消息，不能引用助手自己的解释。不需新增则数组为空。最多 5 条画像、2 条知识和 5 条事件。",
        messages: [{ role: "user", content: [{ type: "text", text: `已有记忆：${JSON.stringify({facts:memory.snapshot().facts,notes:memory.snapshot().notes?.map(n=>({title:n.title,body:n.body.slice(0,200)})),learner:learner?.snapshot?.()}).slice(0, 7000)}\n本轮相关对话：\n${text}` }], timestamp: Date.now() }],
      }, { requestPriority:"background", maxTokens: 1200, reasoning: "off", signal: controller.signal });
      const output = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      const match = output.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("模型未返回有效整理结果");
      let update = JSON.parse(match[0]);
      if (['error', 'aborted', 'length'].includes(response.stopReason)) throw Error('整理结果不完整');
      const candidates = [
        ...(memory.state.enabled.l1 && Array.isArray(update.facts) ? update.facts.slice(0,8).map(value=>({area:'facts',value})) : []),
        ...(memory.state.enabled.l2 && Array.isArray(update.notes) ? update.notes.slice(0,3).map(value=>({area:'notes',value})) : []),
        ...(memory.state.enabled.l1 && Array.isArray(update.learningEvents) ? update.learningEvents.slice(0,8).map(value=>({area:'learningEvents',value})) : []),
      ];
      const verdict = await judgeValue?.(candidates, { signal: controller.signal, requestPriority:"background" });
      update = {facts:[],notes:[],learningEvents:[]};
      candidates.forEach((candidate,index)=>{if(verdict?.[index])update[candidate.area].push(candidate.value);});
      if (!enabled() || ticket !== generation || sessionDisallowsMemory(selected)) return;
      if (!Object.values(update).some(items=>items.length)) { send({type:'memory_status',status:'idle',message:'本轮没有需要长期保存的内容'}); return; }
      await memory.applyAgentUpdate(update, sessionId);
      if (learner && memory.state.enabled.l1 && Array.isArray(update.learningEvents)) {
        for (const item of update.learningEvents.slice(0, 8)) { if (!enabled() || ticket !== generation || sessionDisallowsMemory(selected)) return; await learner.record(item, sessionId, userTexts(selected)).catch(() => {}); }
        send({ type: "learner", state: learner.snapshot() });
      }
      send({ type: "memory", state: memory.snapshot() });
      send({ type: "memory_status", status: "saved" });
    } catch (error) {
      if (ticket === generation && !controller?.signal.aborted) send({ type: "memory_status", status: "error", message: "记忆整理未完成，下次对话后会再尝试" });
    } finally { if (ticket === generation) controller = undefined; }
  }
  function schedule() { cancel(); if (!enabled() || sessionDisallowsMemory(currentSession())) return; timer = setTimeout(() => { void consolidate(); }, 2500); timer.unref(); }
  return { extension, cancel, schedule, consolidate };
}
