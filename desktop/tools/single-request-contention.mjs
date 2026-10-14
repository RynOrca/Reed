// Isolated contention diagnostic: real scheduling code, fake model, no user data/network.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createMemoryAgent} from '../agent/memory-agent.mjs';
import {ModelRequests} from '../agent/model-requests.mjs';
import {workMemoryExtension} from '../agent/work-memory.mjs';
const session={sessionId:'synthetic-contention',model:{provider:'synthetic',id:'single-slot'},state:{messages:[{role:'user',content:'请记住常用目录 D:\\Synthetic\\notes'}]}};
const memory={state:{enabled:{l1:true,l2:true,work:true}},snapshot:()=>({facts:[],notes:[]}),context:async()=>'',applyAgentUpdate:async()=>{throw Error('diagnostic must not save data');}};
let active=0,peak=0;const waiting=[],calls=[];
const bypass=process.argv.includes("--without-scheduler"),scheduler=new ModelRequests();
const complete=async(_model,context)=>{active++;peak=Math.max(peak,active);const kind=context.systemPrompt.includes('工作经验整理器')?'work':'learning';calls.push({kind,started:Date.now(),active});await new Promise(resolve=>waiting.push(resolve));active--;return {stopReason:'stop',content:[{type:'text',text:kind==='work'?' {"items":[]}':'{"facts":[],"notes":[],"learningEvents":[]}'}]};};
const runtime=async()=>({completeSimple:(model,context,options={})=>bypass?complete(model,context):scheduler.run(model,{signal:options.signal,priority:options.requestPriority},()=>complete(model,context))});
const roles={current:()=>({learnerProfileEnabled:true})};
const working=workMemoryExtension({memory,roles,currentSession:()=>session,reviewEnabled:()=>false,send(){},runtime,currentWorkspace:()=> 'D:\\Synthetic'});
const handlers=new Map();working({on:(kind,handler)=>handlers.set(kind,handler),registerTool(){}});
handlers.get('before_agent_start')();handlers.get('tool_result')({toolName:'read',toolCallId:'synthetic-read',isError:false,content:[{type:'text',text:'已确认常用目录 D:\\Synthetic\\notes'}]});
const learning=createMemoryAgent({memory,currentSession:()=>session,runtime,enabled:()=>true,send(){},judgeValue:async()=>[]});
const pending=working.consolidate();learning.schedule();
try{
 await new Promise(resolve=>setTimeout(resolve,2800));assert.equal(peak,bypass?2:1);
 for(const release of waiting.splice(0))release();await new Promise(resolve=>setTimeout(resolve,0));
 for(const release of waiting.splice(0))release();await pending;await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(calls.map(call=>call.kind),['work','learning']);assert.equal(active,0);
}
finally{learning.cancel();working.cancel();for(const release of waiting)release();await pending;await new Promise(resolve=>setTimeout(resolve,0));}
const report={syntheticOnly:true,fakeRuntime:true,realScheduler:true,peakConcurrentModelCalls:peak,calls,scheduled:!bypass,conclusion:bypass?'uncoordinated background calls overlap':'unified scheduler serializes both real background consolidation paths; no real inference requests sent'};
await mkdir(new URL('../../dist/real-memory-acceptance/',import.meta.url),{recursive:true});await writeFile(new URL(bypass?'../../dist/real-memory-acceptance/single-slot-contention.json':'../../dist/real-memory-acceptance/single-slot-scheduled.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
