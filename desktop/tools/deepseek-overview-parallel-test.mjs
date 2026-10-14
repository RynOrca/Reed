// Real-endpoint check for parallel vault overview batches.
//
// Safety: it never reads a real note. It copies an existing user-config.json into
// an isolated profile, points that copy at a freshly generated synthetic vault and
// deletes the whole profile afterwards. Credential material is never printed.
//
// Usage:
//   node desktop/tools/deepseek-overview-parallel-test.mjs --config "<user-config.json>" \
//     --provider <providerId> --model <modelId> [--concurrency 2] [--reasoning off] [--notes 6]
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!args.config||!args.provider||!args.model)throw Error('需要 --config、--provider、--model');
const concurrency=Number(args.concurrency||2),reasoning=args.reasoning||'off',notes=Number(args.notes||6);
const here=dirname(fileURLToPath(import.meta.url)),artifacts=resolve(here,'../../dist/deepseek-overview-parallel');
await mkdir(artifacts,{recursive:true});

const root=await mkdtemp(join(tmpdir(),'reed-deepseek-overview-'));
const profile=join(root,'profile'),vault=join(root,'vault'),workspace=join(root,'workspace');
await Promise.all([mkdir(profile),mkdir(vault),mkdir(workspace)]);
let child,exitInfo=null;
try{
  const configPath=join(profile,'user-config.json');
  await copyFile(resolve(args.config),configPath);
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const provider=(config.providers?.providers||[]).find(item=>item.id===args.provider);
  if(!provider)throw Error('配置里找不到该提供商');
  provider.parallelRequests=true;provider.maxConcurrentRequests=concurrency;
  config.capabilities={...(config.capabilities||{}),vaultPath:vault,skills:[]};
  config.vaultOverviewSelection={providerId:args.provider,modelId:args.model,reasoning};
  await writeFile(configPath,JSON.stringify(config,null,2));
  await writeFile(join(profile,'app-state.json'),JSON.stringify({provider:args.provider,modelId:args.model,projectPath:workspace}));

  // Six ~2.5 KB synthetic notes become three batches at the 6000-character limit.
  for(let i=0;i<notes;i++)await writeFile(join(vault,`合成笔记-${i}.md`),`# 合成主题 ${i}\n\n## 要点\n\n${('这是一段完全合成的学习笔记内容，用于验证总览的并行批次：矩阵特征值、层叠样式、光合作用、宋词格律。').repeat(24)}\n`);
  const report={provider:provider.name,baseUrl:provider.baseUrl,model:args.model,reasoning,concurrency,notes,vault,events:[]};
  const diagnosticsPath=join(profile,'request-diagnostics.jsonl');
  const seen=[],waiters=new Set();
  const until=(predicate,ms)=>{const prior=seen.find(predicate);if(prior)return Promise.resolve(prior);return new Promise((resolve,reject)=>{const item={predicate,resolve};item.timer=setTimeout(()=>{waiters.delete(item);reject(Error('timeout waiting for '+predicate));},ms);waiters.add(item);});};
  child=spawn(process.execPath,[join(here,'../agent/bridge.mjs')],{cwd:workspace,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:profile,SUMMON_WORKSPACE:workspace},stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
  createInterface({input:child.stdout}).on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}seen.push({...event,at:Date.now()});for(const item of [...waiters])if(item.predicate(event)){waiters.delete(item);clearTimeout(item.timer);item.resolve(event);}});
  await until(e=>e.type==='ready',20000);
  child.stdin.write(JSON.stringify({id:'init',type:'init'})+'\n');
  await until(e=>e.id==='init'&&e.type==='ack',60000);
  const started=Date.now();
  child.stdin.write(JSON.stringify({id:'overview',type:'generate_vault_overview',providerId:args.provider,modelId:args.model,reasoning})+'\n');
  const phases=[];
  const collector=setInterval(()=>{for(const event of seen)synchronize(event);},200);
  const recorded=new Set();
  function synchronize(event){if(event.type!=='vault_overview')return;const key=event.state+'|'+event.message;if(recorded.has(key))return;recorded.add(key);report.events.push({state:event.state,done:event.done,batches:event.batches,failed:event.failed,concurrency:event.concurrency,phase:event.phase,queuedMs:event.queuedMs,elapsedMs:event.elapsedMs,message:event.message,at:Date.now()-started});}
  let outcome;
  try{outcome=await until(e=>e.type==='vault_overview'&&['ready','error'].includes(e.state),Number(args.timeoutMs||600000));}
  finally{clearInterval(collector);for(const event of seen)synchronize(event);}
  report.totalMs=Date.now()-started;
  report.outcome={state:outcome.state,message:outcome.message,done:outcome.done,batches:outcome.batches,failed:outcome.failed,concurrency:outcome.concurrency};
  report.overview=await readFile(join(vault,'Reed-笔记库总览.md'),'utf8').then(text=>text.slice(0,600)).catch(()=>null);
  // Derive real overlap from the bridge's own request diagnostics.
  const lines=await readFile(diagnosticsPath,'utf8').then(text=>text.trim().split('\n')).catch(()=>[]);
  const auxiliary=lines.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(entry=>entry&&entry.requestGroup==='auxiliary'&&entry.type==='request_phase');
  const byRequest=new Map();
  for(const entry of auxiliary){const item=byRequest.get(entry.requestId)||{requestId:entry.requestId,phases:{},first:Date.parse(entry.timestamp),last:Date.parse(entry.timestamp)};item.phases[entry.phase]=(item.phases[entry.phase]||0)+1;item.first=Math.min(item.first,Date.parse(entry.timestamp));item.last=Math.max(item.last,Date.parse(entry.timestamp));byRequest.set(entry.requestId,item);}
  report.requests=[...byRequest.values()].sort((a,b)=>a.first-b.first).map(item=>({requestId:item.requestId,startMs:item.first-Date.parse(auxiliary[0].timestamp),endMs:item.last-Date.parse(auxiliary[0].timestamp),phases:Object.keys(item.phases)}));
  const events=[...byRequest.values()].sort((a,b)=>a.first-b.first);
  let peak=0;
  for(let i=0;i<events.length;i++){const overlaps=events.filter(other=>other.first<events[i].last&&other.last>events[i].first).length;peak=Math.max(peak,overlaps);}
  report.observedPeakConcurrency=peak;
  report.stderrTail=stderr.trim().split('\n').slice(-3);
  await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{
  if(child){child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(resolve,2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();});}
  // The copied profile holds encrypted credentials: always remove it.
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
void exitInfo;void readdir;
