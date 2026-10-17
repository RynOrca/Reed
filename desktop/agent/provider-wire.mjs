import { randomUUID,createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {readFileSync} from 'node:fs';
import { EventSourceStream } from 'undici/lib/web/eventsource/eventsource-stream.js';
import { createThinkingGuard } from "./thinking-guard.mjs";

const encoder = new TextEncoder();
const encode = value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const code = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
const toolId = value => createHash('sha256').update(String(value)).digest('hex');
const terminalRaw = new Set(['stop_token','stop_string','output_limit','context_capacity','cancelled']);
const incompleteCodes = new Set(['incomplete_response','incomplete_reasoning','upstream_incomplete','upstream_failure','transport_incomplete','malformed_tool_call','invalid_tool_call','unknown_terminal','thinking_repetition']);
const installedVersions=Object.fromEntries([['piAi','@earendil-works/pi-ai'],['piCodingAgent','@earendil-works/pi-coding-agent'],['undici','undici']].map(([key,path])=>{try{return [key,JSON.parse(readFileSync(new URL(`./node_modules/${path}/package.json`,import.meta.url),'utf8')).version];}catch{return [key,'unknown'];}}));

export function wireOutcome(wire, base = {}) {
  if (!wire?.enforced) return base;
  const extra = { ...base, wire, code:wire.serverErrorCode || wire.errorCode || wire.rawFinishReason || wire.finishReason };
  if (wire.cancelled || wire.status==='cancelled' || wire.rawFinishReason === 'cancelled') return {...extra,status:'aborted',message:wire.cancelled?'本地已取消；服务端取消状态尚未确认':'模型服务报告取消；引擎是否空闲尚未确认'};
  // Reed stopped the stream itself because the model was repeating one planning
  // line. This is not a service error and not a time/token limit.
  if (wire.errorCode === 'thinking_repetition') return {...extra,status:'error',code:'thinking_repetition',message:'模型在思考里反复复述同一句、没有调用工具，已停止本次请求'};
  if (!wire.transportComplete) return {...extra,status:'error',message:`模型响应传输未完成（${wire.errorCode || 'transport_incomplete'}），未执行本次工具调用`};
  if (wire.errorCode) return {...extra,status:'error',message:`模型服务返回 ${wire.errorCode}，本次响应未完成`};
  if (wire.status === 'limited') return {...extra,status:'truncated',code:wire.limitReason,message:`模型生成达到长度限制（${wire.limitReason}），本次工具未执行`};
  if (wire.status !== 'completed') return {...extra,status:'empty',message:wire.malformedTools?'模型返回不完整工具占位，本次工具未执行':'模型响应未完成，没有可交付的正文或有效工具调用'};
  if(base.stopReason==='error')return {...extra,status:'error',code:'sdk_decode_failure',message:'SDK未能解码响应，不能当作完整成功'};
  return {...extra,status:'complete',message:''};
}

export function isWireRecoverable(wire) {
  return Boolean(wire?.enforced && !wire.cancelled && wire.rawFinishReason!=='cancelled' &&
    (wire.status==='incomplete' || wire.status==='limited' || incompleteCodes.has(wire.errorCode)));
}

// One instance per actual foreground request. Never shared with the next attempt.
export function createWireAttempt({taskId, index, model, signal, diagnostic=()=>{}, onPhase=()=>{}, sdkVersion=installedVersions,requestGroup='foreground'} = {}) {
  const started=performance.now(), tools=new Map(), buffered=[], allowed=new Set();
  let reader, output, forwarded=0, parserError, bufferBytes=0, errorSeen=false, finished=false;
  const guard = createThinkingGuard();
  const state={enforced:model?.api==='openai-completions',agent_task_id:taskId,agent_model_request_index:index,attempt_id:randomUUID(),sdkVersion,model:model?.id,requestGroup,
    phase:'sending',status:'incomplete',responseMode:null,httpStatus:null,requestId:null,finishReason:null,finishReasons:[],rawFinishReason:null,rawFinishReasons:[],responseStatus:null,errorCode:null,serverErrorCode:null,done:false,
    contentBytes:0,reasoningBytes:0,toolCallCount:0,toolCallIds:[],validToolCallCount:0,malformedTools:0,transportComplete:false,cancelled:false,canPreserveThinking:false,thinkingStop:null,
    times:{sent:{utc:new Date().toISOString(),monotonicMs:started}},usage:{}};
  const snapshot=()=>structuredClone(state);
  const stamp=name=>{state.times[name]??={utc:new Date().toISOString(),monotonicMs:performance.now()};};
  const report=()=>{try{Promise.resolve(diagnostic({type:'model_wire',...snapshot(),elapsedMs:performance.now()-started})).catch(()=>{});}catch{}};
  function failure(value) {state.errorCode??=value;}
  function metadata(obj) {
    const n=obj.ninfer;
    if(n&&typeof n==='object'){
      if(n.raw_finish_reason!==undefined){state.rawFinishReason=code(n.raw_finish_reason)||'unknown';if(!state.rawFinishReasons.includes(state.rawFinishReason))state.rawFinishReasons.push(state.rawFinishReason);}
      if(n.response_status!==undefined)state.responseStatus=code(n.response_status)||'unknown';
      if(n.malformed_tool_call===true)state.malformedFlag=true;
      state.ninfer={...state.ninfer,raw_finish_reason:state.rawFinishReason,response_status:state.responseStatus,malformed_tool_call:state.malformedFlag===true};
      for(const key of ['reasoning_tokens','reasoning_bytes','content_bytes','tool_call_count','valid_tool_call_count'])if(n[key]!==undefined)state.ninfer[key]=number(n[key]);
    }
    const u=obj.usage;
    if(u&&typeof u==='object')state.usage={counting:u.prompt_tokens!=null?'wire_prompt_total_includes_cached':'wire_input_reported_semantics_unknown',inputTotal:number(u.prompt_tokens??u.total_prompt_tokens),inputReported:number(u.input_tokens),
      inputCached:number(u.prompt_tokens_details?.cached_tokens??u.input_tokens_details?.cached_tokens??u.cached_tokens),
      inputProcessed:number(u.processed_prompt_tokens??u.prompt_tokens_processed??u.processed_tokens),completion:number(u.completion_tokens??u.output_tokens),
      reasoning:number(u.completion_tokens_details?.reasoning_tokens??u.output_tokens_details?.reasoning_tokens??n?.reasoning_tokens)};
    // OpenAI-compatible services sometimes send only error.type (for example
    // authentication_error on 401). Keep it instead of flattening to upstream_failure
    // so the UI can tell the user what actually failed.
    if(obj.error){errorSeen=true;state.serverErrorCode=code(obj.error.code)||code(obj.error.type)||'upstream_failure';failure(state.serverErrorCode);}
  }
  function observeTools(parts) {
    for(const part of parts||[]){
      const key=part.index??0, item=tools.get(key)||{id:'',name:'',arguments:''};
      if(part.id){if(item.id&&item.id!==part.id)failure('invalid_tool_call');item.id=part.id;}
      if(part.function?.name)item.name+=part.function.name;
      if(part.function?.arguments)item.arguments+=part.function.arguments;
      tools.set(key,item);
    }
  }
  function event(event) {
    if(state.cancelled)return;
    const data=event.options.data;
    if(data==='[DONE]'){if(state.done)failure('transport_incomplete');state.done=true;stamp('done');return;}
    if(state.done){failure('transport_incomplete');return;}
    let obj;try{obj=JSON.parse(data);}catch{failure('transport_incomplete');return;}
    if(!obj||typeof obj!=='object'){failure('transport_incomplete');return;}
    if(event.type==='error'&&!obj.error)obj={error:{code:code(obj.code)||'upstream_failure'}};
    metadata(obj);
    let terminal=false, hasTools=false;
    for(const choice of obj.choices||[]){
      if(choice.index!=null&&choice.index!==0){failure('invalid_tool_call');continue;}
      if(choice.finish_reason){state.finishReason=code(choice.finish_reason)||'unknown';if(!state.finishReasons.includes(state.finishReason))state.finishReasons.push(state.finishReason);terminal=true;stamp('terminal');}
      const d=choice.delta||choice.message||{};
      state.contentBytes+=typeof d.content==='string'?Buffer.byteLength(d.content):0;
      const reasoning=d.reasoning_content||d.reasoning;
      state.reasoningBytes+=typeof reasoning==='string'?Buffer.byteLength(reasoning):0;
      if(typeof reasoning==='string'&&reasoning){
        const verdict=guard.push(reasoning);
        if(verdict){state.thinkingStop=verdict;failure('thinking_repetition');state.phase='thinking_stopped';}
      }
      if(d.content||reasoning||d.tool_calls?.length){const first=!state.times.firstDelta;stamp('firstDelta');if(first)onPhase('progress');}
      if(d.tool_calls?.length){hasTools=true;observeTools(d.tool_calls);}
    }
    if(terminal||hasTools||obj.usage){bufferBytes+=Buffer.byteLength(data);if(bufferBytes>8*1024*1024){failure('transport_incomplete');return;}buffered.push(obj);}
    // Stream visible text/reasoning now, but hold all tool fragments and terminal
    // frames until EOF + DONE + semantic checks. SDK cannot schedule partial tools.
    const visible={...obj,choices:(obj.choices||[]).map(c=>{const delta={...(c.delta||c.message||{})};delete delta.tool_calls;return {...c,delta,finish_reason:null};})};
    delete visible.error;delete visible.ninfer;
    if(visible.choices.some(c=>Object.keys(c.delta).length)){output?.enqueue(encode(visible));forwarded++;}
  }
  function settle() {
    state.toolCallCount=tools.size;
    state.toolCallIds=[...tools.values()].map(t=>t.id).filter(Boolean).map(toolId);
    const ids=new Set();
    for(const item of tools.values()){
      if(item.name==='malformed_tool_call'){state.malformedTools++;continue;}
      if(!item.id||ids.has(item.id)||!allowed.has(item.name)){failure('invalid_tool_call');continue;}
      ids.add(item.id);
      try{const args=JSON.parse(item.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw Error();state.validToolCallCount++;}catch{failure('invalid_tool_call');}
    }
    state.malformedTools=Math.max(state.malformedTools,state.malformedFlag?1:0);
    if(state.cancelled){state.status='cancelled';return;}
    if(!state.transportComplete){failure('transport_incomplete');state.status='incomplete';return;}
    if(errorSeen){failure(state.serverErrorCode||'upstream_failure');state.status=incompleteCodes.has(state.errorCode)?'incomplete':'failed';return;}
    if(state.rawFinishReasons.includes('cancelled')){state.status='cancelled';return;}
    state.limitReason=state.rawFinishReasons.find(v=>['output_limit','context_capacity'].includes(v))||(state.finishReasons.includes('length')?'length':null);
    if(state.limitReason){state.errorCode=null;state.status='limited';return;}
    if(state.responseStatus==='cancelled'){state.status='cancelled';return;}
    if(state.errorCode){state.status='incomplete';return;}
    if(state.malformedTools){failure('malformed_tool_call');state.status='incomplete';return;}
    if(state.rawFinishReason&&!terminalRaw.has(state.rawFinishReason)){failure('unknown_terminal');state.status='incomplete';return;}
    if(state.responseStatus && state.responseStatus!=='completed'){failure('incomplete_response');state.status='incomplete';return;}
    if(!['stop','tool_calls'].includes(state.finishReason)){failure('unknown_terminal');state.status='incomplete';return;}
    if(!state.contentBytes&&!state.validToolCallCount){failure('incomplete_reasoning');state.status='incomplete';return;}
    state.status='completed';
  }
  function finalize() {
    if(finished)return;finished=true;stamp(state.transportComplete?'streamClosed':'localStreamClosed');settle();
    state.canPreserveThinking=state.transportComplete&&!state.cancelled&&!state.malformedTools&&state.reasoningBytes>0&&
      ['incomplete_reasoning','incomplete_response'].includes(state.errorCode)&&
      (['stop_token','stop_string'].includes(state.rawFinishReason)||(!state.rawFinishReason&&state.finishReason==='stop'));
    state.phase=state.cancelled?'local_aborted':state.status;report();
  }
  function aborted(){
    if(finished)return;state.cancelled=true;stamp('cancelRequested');state.phase='cancel_requested';report();
    try{output?.error(signal.reason||new DOMException('本地已取消','AbortError'));}catch{}
    void reader?.cancel(signal.reason).catch(()=>{});finalize();
  }
  function cleanup(){signal?.removeEventListener('abort',aborted);}
  function error(){return Object.assign(new Error(`Reed model protocol: ${state.errorCode||state.status}`),{code:state.errorCode||state.status});}
  return {
    snapshot, get signal(){return signal;},
    attach(message){if(message&&typeof message==='object')message.reedWire=snapshot();return message;},
    fetch(fetchImpl){return async(input,init={})=>{
      if(!state.enforced)return fetchImpl(input,init);
      try{
        const payload=JSON.parse(init.body||'{}');
        state.reasoningEffort=code(payload.reasoning_effort??payload.reasoning?.effort);
        state.requestedMaxCompletionTokens=number(payload.max_completion_tokens??payload.max_tokens);
        for(const tool of payload.tools||[])if(tool.function?.name)allowed.add(tool.function.name);
      }catch{}
      signal?.addEventListener('abort',aborted,{once:true});
      try{
        signal?.throwIfAborted();state.phase='waiting_headers';
        const response=await fetchImpl(input,{...init,signal:init.signal||signal});
        state.httpStatus=response.status;state.requestId=code(response.headers.get('x-request-id'));stamp('headers');
        if(!response.ok)errorSeen=true;
        const sse=(response.headers.get('content-type')||'').toLowerCase().includes('text/event-stream');
        state.responseMode=sse?'sse':'aggregate';
        if(!sse){
          const body=await response.text();signal?.throwIfAborted();stamp('firstByte');
          let tripped=null;
          try{
            const obj=JSON.parse(body);metadata(obj);
            if(response.ok){
              event({type:'message',options:{data:JSON.stringify({...obj,choices:obj.choices?.map(c=>({...c,delta:c.message}))})}});
              tripped=state.thinkingStop;
              if(!tripped)state.transportComplete=true;
            }else{errorSeen=true;failure('upstream_failure');state.transportComplete=true;}
          }catch{failure('transport_incomplete');}
          finalize();cleanup();
          if(tripped)throw error();
          return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
        }
        if(!response.body){failure('transport_incomplete');finalize();cleanup();throw error();}
        reader=response.body.getReader();state.phase='streaming';
        const utf8=new TextDecoder('utf-8',{fatal:true});
        const parser=new EventSourceStream({maxEventSize:8*1024*1024,push(value){event(value);return true;}});
        parser.on('error',()=>{parserError=true;failure('transport_incomplete');});
        const body=new ReadableStream({
          start(out){output=out;},
          async pull(out){
            try{
              const delivered=forwarded;
              while(true){
                signal?.throwIfAborted();const chunk=await reader.read();signal?.throwIfAborted();
                if(chunk.done){
                  stamp('streamClosed');
                  try{utf8.decode();}catch{failure('transport_incomplete');}
                  if(parser.chunks.length||parser.event.data!==undefined||parser.event.event!==undefined)failure('transport_incomplete');
                  state.transportComplete=state.done&&!parserError&&state.errorCode!=='transport_incomplete';finalize();cleanup();parser.destroy();
                  if(state.status==='completed'||state.status==='limited'){
                    for(const frame of buffered){const normalized=structuredClone(frame);for(const c of normalized.choices||[]){if(c.delta)for(const key of ['content','reasoning','reasoning_content','role'])delete c.delta[key];if(state.status==='limited'){if(c.delta)delete c.delta.tool_calls;if(c.message)delete c.message.tool_calls;c.finish_reason='length';}}out.enqueue(encode(normalized));}
                    out.enqueue(encoder.encode('data: [DONE]\n\n'));out.close();
                  }else out.error(error());
                  return;
                }
                stamp('firstByte');try{utf8.decode(chunk.value,{stream:true});}catch{failure('transport_incomplete');}parser.write(Buffer.from(chunk.value));
                if(parserError||state.errorCode==='transport_incomplete'||state.thinkingStop){void reader.cancel().catch(()=>{});finalize();cleanup();parser.destroy();out.error(error());return;}
                // Already enqueued visible deltas; give the consumer a chance to render.
                if(forwarded>delivered)return;
              }
            }catch(e){
              if(!state.cancelled){failure('transport_incomplete');finalize();}
              cleanup();parser.destroy();try{out.error(signal?.aborted?signal.reason:e);}catch{}
            }
          },
          cancel(reason){if(signal?.aborted){state.cancelled=true;stamp('cancelRequested');}else failure('transport_incomplete');void reader.cancel(reason).catch(()=>{});finalize();cleanup();parser.destroy();},
        });
        return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
      }catch(e){if(signal?.aborted)aborted();else if(!state.cancelled){failure('upstream_failure');finalize();}cleanup();throw e;}
    };},
  };
}

export function createToolLedger({currentAttempt,isActive=()=>true,diagnostic=()=>{}}) {
  const entries=new Map();
  return pi=>{
    const record=entry=>{pi.appendEntry?.('reed_tool_ledger',entry);void Promise.resolve(diagnostic({type:'tool_ledger',...entry})).catch(()=>{});};
    pi.on('tool_call',event=>{
      if(!isActive())return {block:true,terminate:true,reason:'旧会话的工具调用已失效，未执行'};
      const attempt=currentAttempt(),wire=attempt?.snapshot();
      if(event.toolName==='malformed_tool_call')return {block:true,reason:'不完整工具占位不可执行'};
      if(!wire?.enforced)return;
      if(attempt.signal?.aborted||wire.status!=='completed'||!wire.transportComplete)return {block:true,terminate:true,reason:'模型响应未完整成功，本次工具未执行'};
      if(wire.toolCallIds&&!wire.toolCallIds.includes(toolId(event.toolCallId)))return {block:true,terminate:true,reason:'工具调用不属于当前attempt，未执行'};
      const key=wire.attempt_id+':'+event.toolCallId;
      if(entries.has(key))return {block:true,terminate:true,reason:'同一attempt/tool_call_id已调度，副作用状态须核对，禁止重复执行'};
      entries.set(key,'started');
      record({agent_task_id:wire.agent_task_id,attempt_id:wire.attempt_id,tool_call_id_hash:toolId(event.toolCallId),state:'started'});
    });
    pi.on('tool_execution_end',event=>{
      if(!isActive())return;
      const wire=currentAttempt()?.snapshot();if(!wire?.enforced)return;
      const key=wire.attempt_id+':'+event.toolCallId;
      if(entries.get(key)!=='started')return;
      // An execution error does not prove that an external side effect never ran.
      entries.set(key,event.isError?'unknown':'completed');
      record({agent_task_id:wire.agent_task_id,attempt_id:wire.attempt_id,tool_call_id_hash:toolId(event.toolCallId),state:entries.get(key)});
      if(entries.size>4096){const first=entries.keys().next().value;if(entries.get(first)!=='started')entries.delete(first);}
    });
    pi.on('tool_result',event=>{
      if(event.isError&&['write','edit','powershell','bash','mcp_invoke'].includes(event.toolName))return {isError:true,content:[...event.content,{type:'text',text:'操作报错不等于副作用一定未发生。先用只读方法核对实际结果，不要自动重发；无法确认时报告未完成并停止，等待用户处理。'}]};
    });
  };
}
