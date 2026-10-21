import { createHash } from "node:crypto";
import { classifyAssistantOutcome, isMalformedStreamError } from "./turn-outcome.mjs";
import {isWireRecoverable} from './provider-wire.mjs';

const recoveryHint = "The previous model request ended without a visible answer or a tool call. Continue the original user task from the valid history above. Do not repeat completed work or ask the user to repeat the task. Preserve the configured reasoning depth. Produce the next useful answer or a complete, valid tool call; split large file operations into smaller calls if needed.";

// The model looped in its thinking phase and never reached a tool call. Planning
// again is exactly what failed, so this continuation asks for one concrete action
// instead of resuming the plan. It adds no time or token limit.
const actionHint = "The previous attempt was stopped because it kept repeating the same plan line without any tool call. Do not explain or restate the plan. Use the existing tool results. Immediately perform the smallest concrete step: call exactly one tool with complete valid arguments or return the final answer. Prefer a focused edit when repairing an existing file; write a new file only when the task requires one. After each tool result, briefly state what changed and continue with the next step.";

function replayCompletedThinking(payload, message) {
  // The SDK drops Chat Completions assistants with reasoning but no content/tools.
  // Restore only a complete same-model raw reasoning block, immediately before
  // our appended continuation. Never turn reasoning into visible assistant text.
  if(message?.api!=='openai-completions' || !(message.stopReason==='stop'||message.reedWire?.canPreserveThinking) || payload.model!==message.model || !Array.isArray(payload.messages))return payload;
  const blocks=(message.content||[]).filter(b=>b.type==='thinking'&&b.thinking?.trim());
  if(!blocks.length)return payload;
  const field=blocks[0].thinkingSignature;
  if(!['reasoning_content','reasoning'].includes(field)||blocks.some(b=>b.thinkingSignature!==field))return payload;
  const thinking=blocks.map(b=>b.thinking).join('\n');
  if(payload.messages.some(m=>m.role==='assistant'&&(m[field]===thinking||m.content===thinking||(Array.isArray(m.content)&&m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n\n')===thinking))))return payload;
  const messages=[...payload.messages];
  const tail=messages.at(-1);
  if(tail?.role!=='user'||!JSON.stringify(tail.content).includes(recoveryHint))return payload;
  messages.splice(messages.length-1,0,{role:'assistant',content:'',[field]:thinking});
  return {...payload,messages};
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

export function createTurnRecovery({ send, diagnostic = async () => {},currentAttempt=()=>null }) {
  let active = false, attempted = false, recovering = false, requestNumber = 0;
  let lastMessage = null;
  const willRecover = message => {
    if(message?.reedWire&&currentAttempt()&&message.reedWire.attempt_id!==currentAttempt())return false;
    const outcome = classifyAssistantOutcome(message);
    const heldInvalidTool=Boolean(message?.reedWire?.enforced&&message.reedWire.transportComplete&&message.reedWire.errorCode==='invalid_tool_call');
    return active && !attempted && outcome.status!=='aborted' && (!outcome.hasText||heldInvalidTool) && !outcome.hasToolCalls && (["truncated", "empty"].includes(outcome.status) || isMalformedStreamError(message) || isWireRecoverable(message?.reedWire));
  };
  return {
    begin() { active = true; attempted = false; recovering = false; requestNumber = 0; lastMessage = null; },
    end() { active = false; recovering = false; },
    outcome() { return classifyAssistantOutcome(lastMessage); },
    get continuing(){return active&&attempted;},
    willRecover,
    extension(pi) {
      pi.on('tool_result', event => {
        if(event.toolName !== 'malformed_tool_call')return;
        return {isError:true,content:[{type:'text',text:`不完整工具调用未执行。${event.input?.error || '工具参数在输出结束时尚未闭合。'} 请核对工具schema并重新发起完整调用；大文件分成较小的操作，不得声称这次写入已完成。`}]};
      });
      // Agent core ignores turn_end continuation for errors. The session's public
      // settlement boundary can resume from the preserved user message instead.
      pi.on("agent_before_settle", () => {
        if (active && recovering) return { continue: true };
      });
      pi.on("before_provider_request", async event => {
        if (!active) return;
        const isRecovery = recovering;
        recovering = false;
        // Continuation is an appended internal message. Never rewrite the cached
        // system prefix, tool schema, reasoning settings or output budget.
        const payload = isRecovery ? replayCompletedThinking(event.payload,lastMessage) : event.payload;
        await diagnostic({ type: "request", request: ++requestNumber, recovery: isRecovery, ...summarizeRequest(payload) });
        return payload;
      });
      pi.on("turn_end", async event => {
        if (!active || event.message.role !== "assistant") return;
        if(event.message.reedWire&&currentAttempt()&&event.message.reedWire.attempt_id!==currentAttempt())return;
        lastMessage = event.message;
        const outcome = classifyAssistantOutcome(lastMessage);
        await diagnostic({ type: "response", request: requestNumber, outcome, rawStopReason:lastMessage.rawStopReason??null, usage: lastMessage.usage });
        if (willRecover(lastMessage)) {
          attempted = true; recovering = true;
          const needsAction = outcome.code === 'thinking_repetition';
          // A looped planning stream is never replayed: replaying it would feed the
          // same degenerate reasoning back into the next attempt.
          const preserveThinking = needsAction ? false : (lastMessage.reedWire?.canPreserveThinking || (outcome.status === 'empty' && outcome.stopReason === 'stop'));
          const reason = needsAction
            ? '模型在思考里反复复述计划，已停止并改为立即执行一次'
            : outcome.status === 'error' ? `模型响应未完成（${outcome.code || 'transport_incomplete'}），保持原思考设置重试一次`
              : isMalformedStreamError(lastMessage) ? '流式响应损坏，保持原思考设置重试一次' : '模型已结束但未产生回复或工具调用，保持原思考设置续接一次';
          send({ type: "recovery", message: reason });
          const partial=outcome.hasText?lastMessage.content.filter(block=>block.type==='text'):null;
          const entries = preserveThinking ? [] : [{ type: 'context_edit', targetId: event.messageEntryId, replacement: partial?{content:partial}:null }];
          entries.push({ type: 'custom_message', customType: 'reed_model_continuation', content: partial?'The preceding partial answer is already visible to the user. Its tool call was invalid and was NOT executed. Do not repeat that text. Continue the user task by calling an available tool with complete valid JSON arguments. Use only exact tool names declared in the tool schema.':needsAction ? actionHint : recoveryHint, display: false, details: { reason: outcome.status, preserveThinking, ...(needsAction ? { code: outcome.code } : {}) } });
          return { entries, continue: true };
        }
        // Avoid a second SDK compact-and-retry after our bounded recovery fails.
        // The raw transcript retains the attempt for history and diagnosis.
        if (outcome.status === "truncated" || (lastMessage.reedWire?.enforced && outcome.status!=='complete')) {
          return { entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }], continue: false };
        }
      });
    },
  };
}
