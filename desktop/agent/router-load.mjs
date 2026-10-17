import {performance} from 'node:perf_hooks';

const fields=['admitted','running','prefilling','decode_ready','waiting','materializing'];
export function classifyRouterLoad(data,model) {
  const b=data?.backend,r=b?.requests;
  if(data?.object!=='router.load'||b?.object!=='ninfer.load'||data.backend_changed===true||b.backend_changed===true||data.model!==model||b.model!==model||typeof data.router_busy!=='boolean'||fields.some(k=>!Number.isInteger(r?.[k])||r[k]<0))return {state:'unknown',message:'服务端状态未知，取消尚未确认'};
  const counts=Object.fromEntries(fields.map(k=>[k,r[k]]));
  const counters=Object.fromEntries(['computed_prefill_tokens','committed_decode_tokens'].map(k=>[k,Number.isFinite(b.counters?.[k])&&b.counters[k]>=0?b.counters[k]:null]));
  const state=!data.router_busy&&fields.every(k=>r[k]===0)?'idle':r.prefilling||r.materializing?'prefilling':r.decode_ready?'generating':r.waiting?'queued':'busy';
  return {state,counts,counters,message:{idle:'引擎当前空闲（负载采样，不是本次取消确认）',prefilling:'引擎当前正在预填充（可能包含其他请求）',generating:'引擎当前正在生成（可能包含其他请求）',queued:'引擎当前有排队请求',busy:'引擎当前忙碌；本次取消尚未确认'}[state]};
}

export async function sampleRouterLoad({baseUrl,model,signal,fetchImpl=fetch,emit=()=>{},diagnostic=()=>{},maxSamples=6,intervalMs=1000,timeoutMs=750}={}) {
  const url=new URL(baseUrl);url.pathname='/router/load';url.search='';url.hash='';
  const start=performance.now();
  for(let index=0;index<maxSamples&&!signal?.aborted;index++){
    let sample;
    try{
      const response=await fetchImpl(url,{method:'GET',signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...[signal].filter(Boolean)])});
      sample=response.ok?classifyRouterLoad(await response.json(),model):{state:'unknown',httpStatus:response.status,message:'服务端状态未知，取消尚未确认'};
    }catch{if(signal?.aborted)return;sample={state:'unknown',message:'服务端状态未知，取消尚未确认'};}
    if(signal?.aborted)return;
    const event={...sample,sample:index+1,timestamp:new Date().toISOString(),monotonicMs:performance.now(),elapsedMs:performance.now()-start};
    emit(event);try{await diagnostic({type:'router_load',...event});}catch{}
    if(sample.state==='unknown'||sample.state==='idle')return;
    if(index+1<maxSamples)await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,intervalMs);signal?.addEventListener('abort',finish,{once:true});if(signal?.aborted)finish();
    });
  }
}
