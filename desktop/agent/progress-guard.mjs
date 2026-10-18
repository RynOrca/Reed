import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const fileHash=async path=>{try{return hash(await readFile(path));}catch(error){return error.code==='ENOENT'?'missing':null;}};
const guidance='工具执行成功不等于任务有进展。已有文件的局部问题优先用 edit 精确修改，只有新建文件或确实需要整体替换时才使用 write。利用已返回的工具结果推进任务；重复动作前说明需要验证的新变化，不反复读取未变化的同一段或机械重试相同错误。';

// Observe completed tool results, never private model reasoning. This is a
// stagnation guard, not a limit on task duration, output or useful tool calls.
export function createProgressGuard({workspace=()=>process.cwd(),diagnostic=()=>{},warnAt=3,stopAt=6}={}){
  let active=false,stagnant=0,warned=false,stopped=false,polling=false;
  const seen=new Map(),before=new Map();
  const key=event=>hash(stable([event.toolName,event.input]));
  const allowedPoll=event=>/^(wait|sleep|poll|status)$/.test(event.toolName)||(['status','poll','wait'].includes(event.input?.action));
  const report=phase=>{try{Promise.resolve(diagnostic({type:'task_progress',phase,stagnant})).catch(()=>{});}catch{}};
  return {
    begin(prompt=''){active=true;stagnant=0;warned=false;stopped=false;polling=/轮询|持续监控|定期检查|等待.*(?:完成|变化)|\b(?:poll|monitor|wait until)\b/i.test(prompt);seen.clear();before.clear();},
    end(){active=false;before.clear();},
    outcome(base){return stopped?{...base,status:'error',code:'task_no_progress',message:'多次工具调用未获得新信息或产生有效修改，纠偏后仍无进展，本轮已停止。'}:base;},
    extension(pi){
      pi.on('context_with_system',event=>event.messages[0]?.role==='system'?{messages:[...event.messages,{role:'system',content:'',sections:{reed_task_progress:guidance}}]}:undefined);
      pi.on('tool_call',async event=>{
        if(!active)return;
        if(stopped)return {block:true,terminate:true,reason:'纠偏后工具操作仍未推进任务，停止循环；请报告卡点，不得声称完成。'};
        if(['write','edit'].includes(event.toolName)&&typeof event.input?.path==='string')before.set(event.toolCallId,await fileHash(resolve(workspace(),event.input.path)));
      });
      pi.on('tool_result',async event=>{
        if(!active||event.toolName==='show_learning'||allowedPoll(event))return;
        const mutation=['write','edit'].includes(event.toolName);
        let changed=false;
        if(mutation&&before.has(event.toolCallId)){
          const previous=before.get(event.toolCallId);before.delete(event.toolCallId);
          const next=await fileHash(resolve(workspace(),event.input.path));
          changed=previous!==null&&next!==null&&previous!==next;
        }
        const signature=hash(stable([event.isError,event.content,event.details]));
        const call=key(event),old=seen.get(call);
        // Explicit monitoring may legitimately return identical read-only data.
        if(polling&&!mutation&&!event.isError)return;
        if(changed||(!mutation&&old!==signature)){
          stagnant=0;warned=false;seen.set(call,signature);
        }else{
          seen.set(call,signature);stagnant++;
        }
        if(seen.size>128)seen.delete(seen.keys().next().value);
        if(stagnant>=stopAt){stopped=true;report('stopped');}
        else if(stagnant>=warnAt&&!warned){warned=true;report('correction');}
        else return;
        return {isError:event.isError,content:[...(event.content||[]),{type:'text',text:stopped?'执行监测：纠偏后仍重复相同操作且没有新结果，本轮停止；请如实报告未完成与卡点。':`执行监测：最近 ${stagnant} 次操作没有获得新信息或有效修改。结果已经在上下文中，请利用现有证据选择不同的下一步；修复已有文件优先局部编辑，不再重读相同范围或重复整体覆盖。`}]};
      });
    },
  };
}
