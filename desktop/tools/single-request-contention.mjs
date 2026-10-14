// Isolated contention diagnostic: real scheduling code, fake model, no user data/network.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createMemoryAgent} from '../agent/memory-agent.mjs';
import {workMemoryExtension} from '../agent/work-memory.mjs';
const session={sessionId:'synthetic-contention',model:{provider:'synthetic',id:'single-slot'},state:{messages:[{role:'user',content:'请记住常用目录 D:\\Synthetic\\notes'}]}};
const memory={state:{enabled:{l1:true,l2:true,work:true}},snapshot:()=>({facts:[],notes:[]}),context:async()=>'',applyAgentUpdate:async()=>{throw Error('diagnostic must not save data');}};
let active=0,peak=0;const waiting=[],calls=[];
const runtime=async()=>({completeSimple:async(_model,context)=>{active++;peak=Math.max(peak,active);const kind=context.systemPrompt.includes('工作经验整理器')?'work':'learning';calls.push({kind,started:Date.now(),active});await new Promise(resolve=>waiting.push(resolve));active--;return {stopReason:'stop',content:[{type:'text',text:kind==='work'?' {"items":[]}':'{"facts":[],"notes":[],"learningEvents":[]}'}]};}});
const roles={current:()=>({learnerProfileEnabled:true})};
const working=workMemoryExtension({memory,roles,currentSession:()=>session,reviewEnabled:()=>false,send(){},runtime,currentWorkspace:()=> 'D:\\Synthetic'});
const handlers=new Map();working({on:(kind,handler)=>handlers.set(kind,handler),registerTool(){}});
handlers.get('before_agent_start')();handlers.get('tool_result')({toolName:'read',toolCallId:'synthetic-read',isError:false,content:[{type:'text',text:'已确认常用目录 D:\\Synthetic\\notes'}]});
const learning=createMemoryAgent({memory,currentSession:()=>session,runtime,enabled:()=>true,send(){},judgeValue:async()=>[]});
const pending=working.consolidate();learning.schedule();
try{await new Promise(resolve=>setTimeout(resolve,2800));assert.equal(peak,2,'current separate background schedulers can overlap');}
finally{learning.cancel();working.cancel();for(const release of waiting)release();await pending;await new Promise(resolve=>setTimeout(resolve,0));}
const report={syntheticOnly:true,fakeRuntime:true,realScheduler:true,peakConcurrentModelCalls:peak,calls,conclusion:'work consolidation can overlap learning consolidation scheduled 2.5 seconds later; no real inference requests were sent'};
await mkdir(new URL('../../dist/real-memory-acceptance/',import.meta.url),{recursive:true});await writeFile(new URL('../../dist/real-memory-acceptance/single-slot-contention.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
