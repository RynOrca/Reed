import { createHash } from "node:crypto";
import { classifyAssistantOutcome, isMalformedStreamError } from "./turn-outcome.mjs";

const recoveryHint = "The previous request ended without visible text or a tool call. Continue the original user task now. Keep reasoning brief, then produce a visible answer or call the required tool. Do not ask the user to repeat the task.";

function recoveryPayload(payload) {
  const next = { ...payload };
  // Change only this request; leave the user's persisted thinking preference intact.
  if (typeof next.reasoning_effort === "string") next.reasoning_effort = "low";
  if (next.reasoning?.effort) next.reasoning = { ...next.reasoning, effort: "low" };
  if (next.output_config?.effort) next.output_config = { ...next.output_config, effort: "low" };
  if (typeof next.enable_thinking === "boolean") next.enable_thinking = false;
  if (typeof next.chat_template_kwargs?.enable_thinking === "boolean") next.chat_template_kwargs = { ...next.chat_template_kwargs, enable_thinking: false };
  for (const field of ["thinking_budget", "thinking_token_budget"]) {
    if (Number.isFinite(next[field])) next[field] = Math.min(next[field], 1024);
  }
  if (next.thinking?.type === "enabled" && Number.isFinite(next.thinking.budget_tokens)) {
    next.thinking = { ...next.thinking, budget_tokens: Math.min(next.thinking.budget_tokens, 1024) };
  } else if (next.thinking?.type === "enabled") {
    next.thinking = { ...next.thinking, type: "disabled" };
  }
  // A transient instruction is safer than persisting artificial user messages.
  if (typeof next.instructions === "string") next.instructions += `\n\n${recoveryHint}`;
  else if (typeof next.system === "string") next.system += `\n\n${recoveryHint}`;
  else if (Array.isArray(next.system)) next.system = [...next.system, { type: "text", text: recoveryHint }];
  else if (Array.isArray(next.messages)) {
    next.messages = next.messages.map(message => ({ ...message }));
    const head = next.messages.find(message => ["system", "developer"].includes(message.role));
    if (head && typeof head.content === "string") head.content += `\n\n${recoveryHint}`;
    else next.messages.unshift({ role: "system", content: recoveryHint });
  }
  return next;
}

export function summarizeRequest(payload) {
  const messages = payload.messages ?? payload.input;
  const users = Array.isArray(messages) ? messages.filter(message => message.role === "user") : typeof messages === "string" ? [{ content: messages }] : [];
  return {
    model: payload.model,
    maxTokens: payload.max_tokens ?? null,
    maxCompletionTokens: payload.max_completion_tokens ?? null,
    maxOutputTokens: payload.max_output_tokens ?? null,
    reasoningEffort: payload.reasoning_effort ?? payload.reasoning?.effort ?? payload.output_config?.effort ?? null,
    thinkingType: payload.thinking?.type ?? null,
    enableThinking: payload.enable_thinking ?? payload.chat_template_kwargs?.enable_thinking ?? null,
    thinkingBudget: payload.thinking_budget ?? payload.thinking_token_budget ?? payload.thinking?.budget_tokens ?? null,
    userMessages: users.map(message => {
      const text = typeof message.content === "string" ? message.content : (Array.isArray(message.content) ? message.content : []).filter(block => ["text", "input_text"].includes(block.type)).map(block => block.text || "").join("\n");
      return { length: text.length, hash: createHash("sha256").update(text).digest("hex") };
    }),
  };
}

export function createTurnRecovery({ send, diagnostic = async () => {} }) {
  let active = false, attempted = false, recovering = false, requestNumber = 0;
  let lastMessage = null;
  const willRecover = message => {
    const outcome = classifyAssistantOutcome(message);
    return active && !attempted && !outcome.hasText && !outcome.hasToolCalls && (["truncated", "empty"].includes(outcome.status) || isMalformedStreamError(message));
  };
  return {
    begin() { active = true; attempted = false; recovering = false; requestNumber = 0; lastMessage = null; },
    end() { active = false; recovering = false; },
    outcome() { return classifyAssistantOutcome(lastMessage); },
    willRecover,
    extension(pi) {
      // Agent core ignores turn_end continuation for errors. The session's public
      // settlement boundary can resume from the preserved user message instead.
      pi.on("agent_before_settle", () => {
        if (active && recovering) return { continue: true };
      });
      pi.on("before_provider_request", async event => {
        if (!active) return;
        const isRecovery = recovering;
        recovering = false;
        const payload = isRecovery ? recoveryPayload(event.payload) : event.payload;
        await diagnostic({ type: "request", request: ++requestNumber, recovery: isRecovery, ...summarizeRequest(payload) });
        return payload;
      });
      pi.on("turn_end", async event => {
        if (!active || event.message.role !== "assistant") return;
        lastMessage = event.message;
        const outcome = classifyAssistantOutcome(lastMessage);
        await diagnostic({ type: "response", request: requestNumber, outcome, usage: lastMessage.usage });
        if (willRecover(lastMessage)) {
          attempted = true; recovering = true;
          send({ type: "recovery", message: isMalformedStreamError(lastMessage) ? "流式响应损坏，正在保留原任务并降低思考强度重试一次" : "模型未产生回复或工具调用，正在保留原任务并降低思考强度重试一次" });
          return { entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }], continue: true };
        }
        // Avoid a second SDK compact-and-retry after our bounded recovery fails.
        // The raw transcript retains the attempt for history and diagnosis.
        if (outcome.status === "truncated") {
          return { entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }], continue: false };
        }
      });
    },
  };
}
