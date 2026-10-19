import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';

export const LEARNING_BLOCK_TOOL = 'show_learning';
const str = (max = 1600) => Type.String({minLength:1,maxLength:max});
const object = fields => Type.Object(fields,{additionalProperties:false});
const list = (item,max=6) => Type.Array(item,{minItems:1,maxItems:max});
const base = {id:str(80),fallbackText:str(2400),source:Type.Optional(object({label:str(240),url:str(2400)}))};
const kind = (type,fields) => object({...base,type:Type.Literal(type),...fields});
export const learningSpecSchema = object({schemaVersion:Type.Literal(1),fallbackText:str(6000),blocks:list(Type.Union([
  kind('flow',{title:str(),layout:Type.Optional(Type.Union([Type.Literal('path'),Type.Literal('timeline')])),nodes:list(object({label:str(),value:str(),note:Type.Optional(str())}))}),
  kind('compare',{title:str(),columns:list(object({title:str(),body:str()}),3)}),
  kind('result',{title:str(),items:list(object({label:str(),value:str(),note:Type.Optional(str())}),3),conclusion:Type.Optional(str())}),
  kind('derivation',{title:str(),steps:list(object({expression:str(),reason:str()}),12)}),
  kind('callout',{title:str(),text:str(),tone:Type.Optional(Type.Union([Type.Literal('note'),Type.Literal('warning')]))}),
  kind('reveal',{title:str(),text:str()}),
  kind('term',{term:str(),definition:str(),before:Type.Optional(str()),after:Type.Optional(str())}),
  kind('choices',{title:str(),options:list(object({id:str(80),label:str(240),replyText:str(1600)}))}),
  kind('fill',{title:str(),label:str(240),placeholder:Type.Optional(str(240)),multiline:Type.Optional(Type.Boolean())}),
]),8)});

// Runs before SDK schema validation; execute() is too late for compatibility.
// Stored receipts continue to use the strict validator without this hook.
export function prepareLearningArguments(input) {
  if(JSON.stringify(input)?.length>60000)throw Error('学习内容超过 60KB');
  const value=structuredClone(input);
  if(Array.isArray(value?.blocks))for(const block of value.blocks){
    if(block?.type!=='choices'||!Array.isArray(block.options))continue;
    const reserved=new Set(block.options.map(option=>option?.id));
    block.options.forEach((option,index)=>{
      if(!option||typeof option!=='object'||Array.isArray(option))return;
      if(!Object.hasOwn(option,'id')){
        let id=`choice-${index+1}`;while(reserved.has(id))id+='-';
        option.id=id;reserved.add(id);
      }
      if(!Object.hasOwn(option,'label')&&typeof option.replyText==='string')option.label=option.replyText.slice(0,240);
    });
  }
  return validateLearningSpec(value);
}

// Validate stored receipts again: history and IPC are not trusted input.
export function validateLearningSpec(value) {
  let nodes=0;
  function visit(schema,data,path='') {
    const fail=message=>{throw Error(`${path||'root'}: ${message}`);};
    if(++nodes>1000)throw Error('学习内容过大');
    if(schema.anyOf){
      const typed=schema.anyOf.filter(part=>part.properties?.type);
      if(typed.length){
        const selected=typed.find(part=>part.properties.type.const===data?.type);
        if(!selected)fail('学习块 type 无效');
        visit(selected,data,path);return;
      }
      if(!schema.anyOf.some(part=>{try{visit(part,data,path);return true;}catch{return false;}}))fail('学习内容类型或字段无效');return;
    }
    if(schema.const!==undefined&&data!==schema.const)fail('学习内容版本或类型无效');
    if(schema.type==='object'){
      if(!data||typeof data!=='object'||Array.isArray(data))fail('学习内容需要对象');
      for(const name of schema.required||[])if(!Object.hasOwn(data,name))fail('学习内容缺少 '+name);
      for(const [name,item]of Object.entries(data)){if(!Object.hasOwn(schema.properties,name))fail('学习内容含不支持的字段 '+name);visit(schema.properties[name],item,path?`${path}.${name}`:name);}
    }else if(schema.type==='array'){
      if(!Array.isArray(data)||data.length<schema.minItems||data.length>schema.maxItems)fail('学习列表长度无效');
      data.forEach((item,index)=>visit(schema.items,item,`${path}[${index}]`));
    }else if(schema.type==='boolean'&&typeof data!=='boolean')fail('布尔字段无效');
    else if(schema.type==='string'&&(typeof data!=='string'||!data.trim()||data.length>schema.maxLength))fail('学习文字长度无效');
  }
  if(JSON.stringify(value)?.length>60000)throw Error('学习内容超过 60KB');
  visit(learningSpecSchema,value);
  const ids=new Set();let questions=0;
  for(const block of value.blocks){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(block.id)||ids.has(block.id))throw Error('学习块 ID 必须唯一');ids.add(block.id);
    if(block.source&&!/^summon-file:[^\r\n]+#L[1-9][0-9]*$/.test(block.source.url))throw Error('来源需使用检索返回的笔记行号 URL');
    if(['choices','fill'].includes(block.type)&&++questions>1)throw Error('一次只展示一个可回答的问题');
    if(block.type==='choices'){
      if(questions>1)throw Error('一次只展示一个可回答的问题');
      const options=new Set();for(const o of block.options){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(o.id)||options.has(o.id))throw Error('选项 ID 必须唯一');options.add(o.id);}
    }
  }
  return structuredClone(value);
}

export function learningReceipt(message){
  if(message?.role!=='toolResult'||message.toolName!==LEARNING_BLOCK_TOOL||message.isError)return null;
  try{return validateLearningSpec(message.details?.learning);}catch{return null;}
}
export function latestLearningQuestion(entries){
  let found=null,parentUserId=null;
  for(const entry of entries){const m=entry.message||entry;if(m.role==='user'){found=null;parentUserId=entry.id||null;}
    const spec=learningReceipt(m);const block=spec?.blocks.find(b=>['choices','fill'].includes(b.type));
    if(block)found={toolCallId:m.toolCallId,block,parentUserId};
  }
  return found;
}
export const learningReplyText = (block,answer) => block.type==='fill'?`关于「${block.title}」：\n${block.label} ${answer.trim()}`:`关于「${block.title}」：${answer.replyText}`;
export function validateLearningReply(entries,sessionId,reply,text){
  const q=latestLearningQuestion(entries);
  if(!reply||reply.sessionId!==sessionId||!q||reply.toolCallId!==q.toolCallId||reply.blockId!==q.block.id)throw Error('该练习已过期或会话已切换，请继续使用输入框');
  if(q.block.type==='fill'){
    if(typeof reply.answer!=='string'||!reply.answer.trim()||reply.answer.length>2000||text!==learningReplyText(q.block,reply.answer))throw Error('填空内容为空、过长或与提交文字不一致');
    return {toolCallId:q.toolCallId,blockId:q.block.id,answer:reply.answer.trim(),parentUserId:q.parentUserId};
  }
  const option=q.block.options.find(o=>o.id===reply.optionId);
  if(!option||text!==learningReplyText(q.block,option))throw Error('快捷回复与原选项不一致');
  return {toolCallId:q.toolCallId,blockId:q.block.id,optionId:option.id,answer:option.label,parentUserId:q.parentUserId};
}

export function learningBlockExtension(){return pi=>{
  pi.registerTool(defineTool({name:LEARNING_BLOCK_TOOL,label:'学习图解',description:'在对话正文当前位置展示学习图解、快捷选项或填空。这是真正的函数调用：按 JSON 参数调用本工具，绝不要把 <show_learning ...>、blocks="[...]" 或 JSON 文本写进正文——写成文字只会显示成代码，不会渲染成组件。在同一轮回复中交替使用：Markdown 讲解 → 调用本工具 → 继续讲解，不要把所有块堆在回复末尾。按教学目的选择少量块（最多 8 个），不必每轮使用；简单回答只用文字。数学一律写 LaTeX：所有字段（标题、nodes 的 label/value/note、items 的 value、columns 的 body、options 的 label、fill.label、reason、definition）与正文的行内公式用 $...$，独立公式用 $$...$$，derivation.expression 用不含分隔符的 LaTeX；不要写 c1*c2 mod n^2 这类纯文本公式，也不要使用全角等号。需要用户回答时不要只写「你觉得呢？」，用 choices（每个选项必须含 id、label、replyText，例如 {"id":"a","label":"先看总结","replyText":"请先总结重点。"}；id 在题内唯一，label 是按钮文字，replyText 是用户会真实说出口的完整句子）或 fill（单个输入框，label 标明要填的字段或等号左侧，multiline 可选）；两者合计最多一个，一次只问一个问题，不预写判题反馈，也不要在用户作答前给出答案。callout 提示易错点与适用条件，reveal 默认折叠线索，term 就地解释术语。fallbackText 必须完整可读，作为组件无法显示时的降级文字。不要输出 HTML 或脚本。source 可选，仅使用 search_notes 返回的 summon-file URL 与行号，不编造来源。完整字段与示例见 learning-blocks 技能。',parameters:learningSpecSchema,
    prepareArguments:prepareLearningArguments,
    async execute(_id,input,signal){signal?.throwIfAborted();const spec=validateLearningSpec(input);return {content:[{type:'text',text:spec.fallbackText}],details:{learning:spec}};}}));
  pi.on('context_with_system',event=>{if(event.messages[0]?.role!=='system')return;return {messages:[...event.messages,{role:'system',content:'',sections:{reed_learning_blocks:'正文富文本能力：需要说明关系、步骤、关键结果时用 show_learning 在正文中插入图解；需要用户回答时用它的 choices 或 fill 提问（不要在正文里提问后等用户打字）。show_learning 必须真正发起工具调用，把 <show_learning ...> 或 JSON 当文字写进正文是错误做法。同一轮用「文字→图解→文字→提问」的顺序交替，最多一个可回答的问题。数学一律用 LaTeX：行内用 $...$，独立公式用 $$...$$，组件字段里不要写 c1*c2 mod n^2 这类纯文本公式，也不要用全角等号。简单回答只用文字。可选展开提示不自动表示掌握；选项只代表用户回复，需结合题目反馈，不把自报“懂了”当掌握证据。不修改角色记忆与学习权限。避免工具重试重复展示。'}}]};});
};}
