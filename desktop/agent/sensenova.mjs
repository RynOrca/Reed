// Token Plan documents max_tokens and OpenAI messages, not OpenAI-only extras.
// Keep this policy scoped to the official Token Plan host; other providers keep
// their own reasoning, structured output and cache protocols.
export function isSenseNova(model){
  try{return model?.api==='openai-completions'&&new URL(model.baseUrl).hostname==='token.sensenova.cn';}catch{return false;}
}
export const senseNovaCompat={supportsStore:false,supportsUsageInStreaming:false,supportsDeveloperRole:false,supportsReasoningEffort:false,supportsStrictMode:false,maxTokensField:'max_tokens'};
export function senseNovaPayload(payload){
  const allowed=['model','messages','stream','max_tokens','temperature','top_p','tools','tool_choice','stop'];
  const result=Object.fromEntries(Object.entries(payload).filter(([key,value])=>allowed.includes(key)&&value!==undefined));
  if(result.max_tokens===undefined&&payload.max_completion_tokens!==undefined)result.max_tokens=payload.max_completion_tokens;
  result.messages=(payload.messages||[]).map(message=>{
    const next=Object.fromEntries(Object.entries(message).filter(([key])=>['role','content','tool_calls','tool_call_id','name'].includes(key)));
    if(next.role==='developer')next.role='system';return next;
  });
  if(result.tools)result.tools=result.tools.map(tool=>({type:tool.type,function:Object.fromEntries(Object.entries(tool.function||{}).filter(([key])=>['name','description','parameters'].includes(key)))}));
  return result;
}
export function withSenseNovaPayload(model,options={}){
  if(!isSenseNova(model))return options;
  return {...options,onPayload:async(payload,selected)=>senseNovaPayload(await options.onPayload?.(payload,selected)??payload)};
}
