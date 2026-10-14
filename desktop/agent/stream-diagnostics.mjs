import { createHash } from "node:crypto";
let requestSequence=0;

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

// Bound both connection/headers and a stalled response body. Retain no payloads,
// credentials, query strings or user text in diagnostics.
export function createRequestFetch(fetchImpl, { signal, diagnostic=()=>{}, onPhase=()=>{}, idleMs=90000, totalMs=300000 }={}) {
  return async (input, init={}) => {
    const controller=new AbortController(), started=Date.now(),requestId=++requestSequence;
    const combined=AbortSignal.any([controller.signal, ...[signal,init.signal].filter(Boolean)]);
    let idle, total, reader, closed=false, first=true;
    const record=(phase,extra={})=>{try{Promise.resolve(diagnostic({type:'request_phase',requestId,phase,elapsedMs:Date.now()-started,...extra})).catch(()=>{});onPhase(phase);}catch{}};
    const timeout=()=>controller.abort(new Error('模型服务长时间未返回数据，请停止后重试，或检查服务与网络。'));
    const touch=()=>{clearTimeout(idle);idle=setTimeout(timeout,idleMs);};
    const cleanup=()=>{if(closed)return;closed=true;clearTimeout(idle);clearTimeout(total);combined.removeEventListener('abort',aborted);};
    const aborted=()=>{record(controller.signal.aborted?'timeout':'cancelled');void reader?.cancel(combined.reason).catch(()=>{});cleanup();};
    combined.addEventListener('abort',aborted,{once:true});touch();total=setTimeout(timeout,totalMs);
    record('connecting');
    try {
      combined.throwIfAborted();
      const response=await fetchImpl(input,{...init,signal:combined});
      combined.throwIfAborted();
      record('headers',{status:response.status});touch();
      if(!response.body){cleanup();return response;}
      reader=response.body.getReader();
      const body=new ReadableStream({
        async pull(out){
          try{combined.throwIfAborted();const chunk=await reader.read();combined.throwIfAborted();if(chunk.done){record('finished');cleanup();out.close();return;}touch();if(first){first=false;record('first_body');}out.enqueue(chunk.value);}
          catch(error){cleanup();out.error(combined.aborted?combined.reason:error);}
        },
        async cancel(reason){cleanup();await reader.cancel(reason);},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){cleanup();record(combined.aborted?(controller.signal.aborted?'timeout':'cancelled'):'failed');throw combined.aborted?combined.reason:error;}
  };
}
