import { createHash } from "node:crypto";

// Observe the wire framing without modifying bytes or retaining response text.
export function createSseObserver(report) {
  const decoder = new TextDecoder();
  const limit = 512 * 1024;
  let pending = "", data = [], eventNumber = 0, reported = false, size = 0;
  const emit = value => { if (!reported) { reported = true; report(value); } };
  function dispatch() {
    if (!data.length) return;
    const text = data.join("\n");
    eventNumber++;
    if (text !== "[DONE]") {
      try { JSON.parse(text); }
      catch {
        emit({ type: "malformed_sse", event: eventNumber, characters: text.length, dataLines: data.length,
          empty: !text.trim(), startsLikeJson: /^[\s]*[\[{]/.test(text), endsLikeJson: /[\]}]\s*$/.test(text),
          invalidUtf8: text.includes("\ufffd"),
          hash: createHash("sha256").update(text).digest("hex") });
      }
    }
    data = []; size = 0;
  }
  function line(text) {
    if (!text) { dispatch(); return; }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    size += value.length;
    if (size > limit) { emit({ type: "sse_diagnostic_limit", event: eventNumber + 1, limit }); return; }
    data.push(value);
  }
  function drain(final) {
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const char = pending[i];
      if (char !== "\r" && char !== "\n") continue;
      if (char === "\r" && i === pending.length - 1 && !final) break;
      line(pending.slice(start, i));
      if (char === "\r" && pending[i + 1] === "\n") i++;
      start = i + 1;
      if (reported) break;
    }
    pending = reported ? "" : pending.slice(start);
    if (pending.length > limit) { emit({ type: "sse_diagnostic_limit", event: eventNumber + 1, limit }); pending = ""; }
    if (final && !reported) { if (pending) line(pending); pending = ""; dispatch(); }
  }
  return {
    push(bytes) { if (!reported) { pending += decoder.decode(bytes, { stream: true }); drain(false); } },
    finish() { if (!reported) { pending += decoder.decode(); drain(true); } },
  };
}

export function createDiagnosticFetch(fetchImpl, diagnostic) {
  return async (...args) => {
    const response = await fetchImpl(...args);
    const contentType = response.headers.get("content-type") || "";
    if (!response.body || !contentType.toLowerCase().includes("text/event-stream")) return response;
    const report = entry => { try { Promise.resolve(diagnostic({ status: response.status, ...entry })).catch(() => {}); } catch {} };
    const observer = createSseObserver(report);
    const body = response.body.pipeThrough(new TransformStream({
      transform(bytes, controller) {
        try { observer.push(bytes); } catch {} // Diagnostics must never break a model request.
        controller.enqueue(bytes);
      },
      flush() { try { observer.finish(); } catch {} },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
