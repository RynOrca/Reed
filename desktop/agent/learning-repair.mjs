// Correction requests contain diagram arguments only, never tools or full notes.
export function createLearningRepair({runtime,currentSession,validate,schema,diagnostic=()=>{}}={}){
  let used=0,generation=0;
  const reset=()=>{used=0;generation++;};
  async function repair(input,initialError,signal){
    const selected=currentSession?.(),ticket=generation;
    if(!selected?.model||!runtime)return null;
    let previous=input,error=initialError;
    while(used<3){
      signal?.throwIfAborted();if(ticket!==generation||currentSession()!==selected)return null;
      const attempt=++used;diagnostic({kind:'learning_repair',attempt,status:'started'});
      try{
        const models=await runtime();signal?.throwIfAborted();
        if(ticket!==generation||currentSession()!==selected)return null;
        const response=await models.completeSimple(selected.model,{
          systemPrompt:`修正学习图解 JSON 参数，只返回完整 JSON 对象，禁止调用工具、输出代码围栏或解释修正过程。保留原有知识、题目与选项含义，不凭空添加知识或答案。必须补齐根和每个块的 fallbackText（完整可读的文本替代内容）。schema：${JSON.stringify(schema)}`,
          messages:[{role:'user',content:[{type:'text',text:JSON.stringify({arguments:previous,diagnostic:String(error?.message||error).slice(0,1800)})}],timestamp:Date.now()}],
        },{signal,reasoning:'off',maxTokens:4096,requestPriority:'foreground',requestTimeoutMs:60000});
        signal?.throwIfAborted();if(ticket!==generation||currentSession()!==selected)return null;
        if(['error','aborted','length'].includes(response.stopReason))throw Error('修正回复不完整');
        const text=response.content.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
        previous=JSON.parse(text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
        const spec=validate(previous);diagnostic({kind:'learning_repair',attempt,status:'saved'});return spec;
      }catch(cause){signal?.throwIfAborted();error=cause;diagnostic({kind:'learning_repair',attempt,status:'invalid'});}
    }
    return null;
  }
  return {repair,reset};
}
