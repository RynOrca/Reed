// A resolved SDK prompt does not imply a completed assistant response.
export function isMalformedStreamError(message) {
  return message?.stopReason === "error" && /malformed server-sent event JSON/i.test(message.errorMessage || "");
}

// Transient transport and provider failures: the SDK retries these inside the
// same turn, so an intermediate failure matching this shape is not terminal.
// Deterministic failures (bad credentials, a bad request, metadata corruption)
// must still reach the user right away.
const RECOVERABLE_FAILURE_PATTERN = /overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|\b(?:429|500|502|503|504|520|524)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|exceeded request buffer limit|network.?error|connection.?error|connection.?(?:refused|reset|lost|closed|aborted)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONN(?:REFUSED|RESET|ABORTED)|EPIPE|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|CLOSED)|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|pending stream has been canceled|please retry your request|you can retry your request|try your request again|ResourceExhausted/i;

export function isRecoverableFailure(message) {
  if (message?.stopReason !== "error") return false;
  const text = String(message.errorMessage || "");
  // A malformed stream is recovered by Reed's own bounded recovery, not by the SDK.
  if (isMalformedStreamError(message)) return true;
  return RECOVERABLE_FAILURE_PATTERN.test(text);
}

export function classifyAssistantOutcome(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const hasText = content.some((block) => block.type === "text" && String(block.text || "").trim());
  const hasThinking = content.some((block) => block.type === "thinking" && String(block.thinking ?? block.text ?? "").trim());
  const hasToolCalls = content.some((block) => block.type === "toolCall");
  const stopReason = message?.stopReason || null;
  const base = { stopReason, hasText, hasThinking, hasToolCalls };
  if (isMalformedStreamError(message)) return { ...base, status: "error", code: "malformed_sse", message: "流式响应损坏：收到的 SSE 事件不是有效 JSON" };
  if (stopReason === "error") return { ...base, status: "error", message: message.errorMessage || "模型请求失败" };
  if (stopReason === "aborted") return { ...base, status: "aborted", message: "已停止回复" };
  // Partial text or tool arguments do not make a length-limited response complete.
  if (stopReason === "length") return { ...base, status: "truncated", message: "输出被截断：模型服务返回了长度限制" };
  if (!hasText && !hasToolCalls) return { ...base, status: "empty", message: hasThinking ? "模型只返回了思考内容，没有回复或工具调用" : "模型没有返回回复或工具调用" };
  return { ...base, status: "complete", message: "" };
}
