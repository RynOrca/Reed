// A resolved SDK prompt does not imply a completed assistant response.
export function classifyAssistantOutcome(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const hasText = content.some((block) => block.type === "text" && String(block.text || "").trim());
  const hasThinking = content.some((block) => block.type === "thinking" && String(block.thinking ?? block.text ?? "").trim());
  const hasToolCalls = content.some((block) => block.type === "toolCall");
  const stopReason = message?.stopReason || null;
  const base = { stopReason, hasText, hasThinking, hasToolCalls };
  if (stopReason === "error") return { ...base, status: "error", message: message.errorMessage || "模型请求失败" };
  if (stopReason === "aborted") return { ...base, status: "aborted", message: "已停止回复" };
  // Partial text or tool arguments do not make a length-limited response complete.
  if (stopReason === "length") return { ...base, status: "truncated", message: "输出被截断：模型服务返回了长度限制" };
  if (!hasText && !hasToolCalls) return { ...base, status: "empty", message: hasThinking ? "模型只返回了思考内容，没有回复或工具调用" : "模型没有返回回复或工具调用" };
  return { ...base, status: "complete", message: "" };
}
