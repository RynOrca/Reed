// One lease per inference request, never per agent turn (tools may request a model too).
export function endpointKey(model) {
  try { const url = new URL(model.baseUrl); return url.origin + url.pathname.replace(/\/+$/, ''); }
  catch { return String(model.provider || 'unknown'); }
}

export function concurrencyLimit(provider) {
  if (provider?.parallelRequests !== true) return 1;
  const value = provider.maxConcurrentRequests;
  return Number.isInteger(value) && value >= 2 && value <= 8 ? value : 2;
}

export class ModelRequests {
  constructor({ providers = () => [], maxWaiting = 32 } = {}) {
    this.providers = providers; this.maxWaiting = maxWaiting; this.endpoints = new Map();
  }
  limit(model) {
    const matches = this.providers().filter(provider => endpointKey(provider) === endpointKey(model));
    // Duplicate provider entries must not create independent slots for the same endpoint.
    return matches.length ? Math.min(...matches.map(concurrencyLimit)) : 1;
  }
  acquire(model, { signal, priority = 'foreground', onWait } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('已取消模型请求', 'AbortError'));
    const key = endpointKey(model);
    let state = this.endpoints.get(key);
    if (!state) { state = { model, active: 0, waiting: [] }; this.endpoints.set(key, state); }
    if (state.waiting.length >= this.maxWaiting) return Promise.reject(new Error('模型等待队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      const job = { priority: priority === 'background' ? 1 : 0, signal, resolve, reject };
      job.abort = () => {
        const index = state.waiting.indexOf(job);
        if (index < 0) return;
        state.waiting.splice(index, 1);
        signal.removeEventListener('abort', job.abort);
        reject(signal.reason || new DOMException('已取消模型请求', 'AbortError'));
        this.drain(key, state);
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      state.waiting.push(job);
      state.waiting.sort((a, b) => a.priority - b.priority);
      this.drain(key, state);
      if (state.waiting.includes(job)) { try { onWait?.(); } catch {} }
    });
  }
  drain(key, state) {
    while (state.active < this.limit(state.model) && state.waiting.length) {
      const job = state.waiting.shift(); job.signal?.removeEventListener('abort', job.abort);
      state.active++; let released = false;
      job.resolve(() => {
        if (released) return;
        released = true; state.active--; this.drain(key, state);
      });
    }
    if (!state.active && !state.waiting.length) this.endpoints.delete(key);
  }
  refresh() { for (const [key, state] of this.endpoints) this.drain(key, state); }
  async run(model, options, request) {
    const release = await this.acquire(model, options);
    try { return await request(); } finally { release(); }
  }
  async complete(model, {signal, priority, queueTimeoutMs=300000, requestTimeoutMs=300000, onState}, request) {
    const started=Date.now(),queue=new AbortController();
    const timeout=(phase)=>Object.assign(new Error(phase==='queue'?'等待模型服务空闲超时':'模型生成超时'),{name:'ModelRequestTimeoutError',phase});
    const queueTimer=setTimeout(()=>queue.abort(timeout('queue')),queueTimeoutMs);
    let release;
    try { release=await this.acquire(model,{signal:signal?AbortSignal.any([signal,queue.signal]):queue.signal,priority,onWait:()=>onState?.({state:'waiting',queuedMs:0})}); }
    finally {clearTimeout(queueTimer);}
    const running=new AbortController(),timer=setTimeout(()=>running.abort(timeout('request')),requestTimeoutMs);
    const requestSignal=signal?AbortSignal.any([signal,running.signal]):running.signal;
    try {
      onState?.({state:'running',queuedMs:Date.now()-started});
      const result=await request(requestSignal);
      if(running.signal.aborted)throw running.signal.reason;
      return result;
    } catch(error) {if(running.signal.aborted)throw running.signal.reason;throw error;}
    finally {clearTimeout(timer);release();}
  }
  async stream(model, options, request) {
    const release = await this.acquire(model, options);
    try {
      const stream = await request();
      // Streaming consumers can return early. Keep the slot until the provider's
      // final result settles, rather than treating an iterator break as cancellation.
      const completed = Promise.resolve().then(() => stream.result()).finally(release);
      completed.catch(() => {});
      return {
        result: () => completed,
        async *[Symbol.asyncIterator]() { yield* stream; },
      };
    } catch (error) { release(); throw error; }
  }
}
