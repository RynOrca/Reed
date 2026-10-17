import { createHash } from "node:crypto";
let requestSequence=0;

const errorTextLimit = 400;
// A credential name in any casing, with ordinary separators around it.
const CREDENTIAL_KEY = "[A-Za-z0-9_.-]*(?:api[-_]?key|apikey|token|secret|password|passwd|credential|signature|sig)[A-Za-z0-9_.-]*";
const ENV_KEY = "[A-Za-z0-9_.-]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_.-]*";
// Each entry captures the credential's name (with its separator) so the surviving
// text still shows what failed, while the value itself is never retained. Only
// credential-shaped names are redacted, so codes such as ETIMEDOUT and a status
// such as "429" survive for diagnosis.
const credentialPatterns = [
  // An authorization value is entirely a credential, scheme included.
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)\S+[^\n;]*/gi, "header"],
  // A well-known key shape is masked whole, because a provider error often quotes it
  // with only part of its middle hidden, as in "sk-abc***xyz".
  [/\bsk-(?!<)[A-Za-z0-9._*-]{8,}/g, "value"],
  [new RegExp(`\\b(${CREDENTIAL_KEY})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\\S+)`, "gi"), "pair"],
  [new RegExp(`\\b(${ENV_KEY}=)([^\\s,;&]+)`, "g"), "pair"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "scheme"],
];
// Transport failures must stay diagnosable without retaining what the request
// carried. Credentials are redacted, then only a short structural summary is kept.
export function sanitizeErrorText(text) {
  let value = String(text ?? "");
  for (const [pattern, kind] of credentialPatterns) {
    value = value.replace(pattern, (match, name, separator) => (kind === "value" ? "<redacted>" : kind === "scheme" ? `${name} <redacted>` : `${name}${separator}<redacted>`));
  }
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, (match, scheme) => `${scheme}<redacted>@`);
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, errorTextLimit);
}
export function describeNetworkError(error, depth = 0, seen = new Set()) {
  if (error === null || error === undefined || typeof error !== "object" || seen.has(error) || depth > 3) return null;
  seen.add(error);
  const description = {
    name: typeof error.name === "string" ? error.name.slice(0, 64) : "Error",
    message: sanitizeErrorText(error.message),
  };
  if (typeof error.code === "string") description.code = error.code.slice(0, 64);
  if (typeof error.errno === "number") description.errno = error.errno;
  if (typeof error.status === "number") description.status = error.status;
  const cause = describeNetworkError(error.cause, depth + 1, seen);
  if (cause) description.cause = cause;
  return description;
}

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
export function createRequestFetch(fetchImpl, { signal, diagnostic=()=>{}, onPhase=()=>{}, idleMs=90000, totalMs=300000, connectionMs=90000, noticeMs=90000, dispatcher }={}) {
  return async (input, init={}) => {
    const controller=new AbortController(), started=Date.now(),requestId=++requestSequence;
    const combined=AbortSignal.any([controller.signal, ...[signal,init.signal].filter(Boolean)]);
    let idle, total, connection, notice, reader, output, closed=false, first=true, lastData=started;
    const record=(phase,extra={})=>{try{Promise.resolve(diagnostic({type:'request_phase',requestId,phase,elapsedMs:Date.now()-started,...extra})).catch(()=>{});onPhase(phase);}catch{}};
    const timeout=(phase)=>controller.abort(Object.assign(new Error(phase==='total'?'模型生成超过单次生成时限，可在提供商设置调整。':phase==='connection'?'连接模型服务超时，请检查服务与网络。':'模型服务长时间未返回数据，可在提供商设置调整无数据超时。'),{name:'ModelRequestTimeoutError',phase}));
    const touch=()=>{lastData=Date.now();clearTimeout(idle);if(idleMs>0)idle=setTimeout(()=>timeout('idle'),idleMs);};
    const cleanup=()=>{if(closed)return;closed=true;clearTimeout(idle);clearTimeout(total);clearTimeout(connection);clearInterval(notice);combined.removeEventListener('abort',aborted);};
    // Error the consumer immediately; an upstream cancel/read promise may never settle.
    const aborted=()=>{record(controller.signal.aborted?'timeout':'cancelled');try{output?.error(combined.reason);}catch{}void reader?.cancel(combined.reason).catch(()=>{});cleanup();};
    combined.addEventListener('abort',aborted,{once:true});
    touch();
    if(connectionMs>0)connection=setTimeout(()=>timeout('connection'),connectionMs);
    if(totalMs>0)total=setTimeout(()=>timeout('total'),totalMs);
    if(noticeMs>0){notice=setInterval(()=>{if(Date.now()-lastData>=noticeMs)record('waiting',{silentMs:Date.now()-lastData});},noticeMs);notice.unref?.();}
    record('connecting');
    try {
      combined.throwIfAborted();
      let rejectAbort;
      const abortPromise=new Promise((_,reject)=>{rejectAbort=()=>reject(combined.reason);combined.addEventListener('abort',rejectAbort,{once:true});if(combined.aborted)rejectAbort();});
      let response;
      try{response=await Promise.race([fetchImpl(input,{...init,...(dispatcher?{dispatcher}:{}),signal:combined}),abortPromise]);}
      finally{combined.removeEventListener('abort',rejectAbort);}
      combined.throwIfAborted();
      clearTimeout(connection);record('headers',{status:response.status});touch();
      if(!response.body){cleanup();return response;}
      reader=response.body.getReader();
      const body=new ReadableStream({
        start(out){output=out;},
        async pull(out){
          try{combined.throwIfAborted();const chunk=await reader.read();combined.throwIfAborted();if(chunk.done){record('finished');cleanup();out.close();return;}touch();if(first){first=false;record('first_body');}out.enqueue(chunk.value);}
          catch(error){cleanup();out.error(combined.aborted?combined.reason:error);}
        },
        cancel(reason){cleanup();void reader.cancel(reason).catch(()=>{});},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){
      cleanup();
      const aborted=combined.aborted, phase=aborted?(controller.signal.aborted?'timeout':'cancelled'):'failed';
      record(phase);
      // A connection that never returns response headers is recorded as a
      // sanitized structural description, so the cause can be told apart later.
      if(phase==='failed')record('error',{error:describeNetworkError(error)});
      throw aborted?combined.reason:error;
    }
  };
}
