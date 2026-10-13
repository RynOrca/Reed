// Opt-in real-provider acceptance. Only synthetic tasks and temporary profiles are sent.
import {access,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {once} from 'node:events';
import assert from 'node:assert/strict';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=join(project,'dist','real-memory-acceptance');await mkdir(artifacts,{recursive:true});
function option(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
const suite=option('--suite')||'full';assert.ok(['full','notes-profile','profile-only','profile-correction'].includes(suite),`未知验收套件：${suite}`);
const bridgePath=resolve(option('--bridge-path')||join(artifacts,'snapshot-agent','bridge.mjs'));
const reportPath=option('--report-path')?resolve(project,option('--report-path')):join(artifacts,suite==='notes-profile'?'continuation-notes-profile.json':suite==='profile-only'?'continuation-profile-only.json':'report.json');
assert.ok(reportPath.startsWith(artifacts+sep),`报告路径必须位于 ${artifacts} 下`);
try{await access(bridgePath);}catch{throw Error(`找不到指定快照 bridge：${bridgePath}`);}
const root=await mkdtemp(join(tmpdir(),'reed-real-memory-'));
const production=join(process.env.APPDATA,'Reed');
const settings=JSON.parse(await readFile(join(production,'user-config.json'),'utf8'));
const appState=JSON.parse(await readFile(join(production,'app-state.json'),'utf8'));
const provider=settings.providers.providers.find(p=>p.id===appState.provider);
assert.ok(provider,'当前模型提供商未配置');
assert.equal(provider.protocol,'openai-completions','这个验收脚本目前仅支持 OpenAI 兼容服务');
const selected=provider.models.find(m=>m.id===appState.modelId);assert.ok(selected);
const requests=[],shellCalls=[],cases=[];let caseName='setup',bridge;
const boundedSuite=['notes-profile','profile-only','profile-correction'].includes(suite),suiteStarted=Date.now(),maxSuiteMs=boundedSuite?360000:Infinity,maxCaseMs=boundedSuite?115000:150000,maxUpstreamMs=boundedSuite?60000:120000,maxRequestsPerCase=boundedSuite?5:12,maxSuiteRequests=boundedSuite?18:Infinity;
const report={suite,bridgePath,model:selected.id,thinking:'low',thinkingCeiling:'medium',outputLimit:2400,syntheticOnly:true,root,cases,requests,shellCalls,requestBudget:{maxSuiteMs:Number.isFinite(maxSuiteMs)?maxSuiteMs:null,maxCaseMs,maxUpstreamMs,maxRequestsPerCase:Number.isFinite(maxRequestsPerCase)?maxRequestsPerCase:null,maxSuiteRequests:Number.isFinite(maxSuiteRequests)?maxSuiteRequests:null}};
let reportWrites=Promise.resolve();const writeReport=()=>{const snapshot=JSON.stringify(report,null,2);reportWrites=reportWrites.catch(()=>{}).then(()=>writeFile(reportPath,snapshot));return reportWrites;};
function classify(system){return /工作经验整理器/.test(system)?'experience_extract':/记忆价值审查器/.test(system)?'value_gate':/判断新增记忆/.test(system)?'deduplicate':/为工作经验检索/.test(system)?'work_expand':/个人笔记检索规划器/.test(system)?'note_expand':/笔记库导航整理器|根据分批笔记浏览结果/.test(system)?'overview':'agent';}
const proxy=createServer(async(req,res)=>{
  let record;
  try{
    if(req.method!=='POST'||!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks),input=JSON.parse(body);
    const system=input.messages.filter(m=>['system','developer'].includes(m.role)).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
    const requestedEffort=input.reasoning_effort??null;input.reasoning_effort='low';
    record={case:caseName,kind:classify(system),system,model:input.model,requestedEffort,effectiveEffort:input.reasoning_effort,started:Date.now(),tools:(input.tools||[]).map(t=>t.function?.name),recentToolResults:input.messages.filter(m=>m.role==='tool').slice(-2).map(m=>({name:m.name,content:typeof m.content==='string'?m.content.slice(0,2500):JSON.stringify(m.content).slice(0,2500)}))};requests.push(record);await writeReport();
    const caseCount=requests.filter(r=>r.case===caseName).length;
    if(caseCount>maxRequestsPerCase||requests.length>maxSuiteRequests||Date.now()-suiteStarted>maxSuiteMs){record.status=429;record.budgetExceeded=true;res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Isolated acceptance request/time budget exceeded'}}));await writeReport();return;}
    const response=await fetch(provider.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(req.headers.authorization?{authorization:req.headers.authorization}:{})},body:JSON.stringify(input),signal:AbortSignal.timeout(maxUpstreamMs)});
    record.status=response.status;res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});
    const reviewChunks=[];let reviewBytes=0;
    for await(const chunk of response.body){if(record.kind==='value_gate'&&reviewBytes<65536){reviewChunks.push(Buffer.from(chunk));reviewBytes+=chunk.length;}res.write(chunk);}
    if(record.kind==='value_gate'){
      const raw=Buffer.concat(reviewChunks).toString('utf8'),parts=[];
      if(raw.trim().startsWith('{'))try{parts.push(JSON.parse(raw));}catch{}
      else for(const line of raw.split('\n'))if(line.startsWith('data: ')&&line.slice(6).trim()!=='[DONE]')try{parts.push(JSON.parse(line.slice(6)));}catch{}
      record.reviewOutput={text:parts.flatMap(p=>(p.choices||[]).map(c=>c.delta?.content||c.message?.content||'')).join(''),finishReasons:parts.flatMap(p=>(p.choices||[]).map(c=>c.finish_reason).filter(Boolean)),usage:parts.findLast(p=>p.usage)?.usage,captureTruncated:reviewBytes>65536};
    }
    res.end();record.ms=Date.now()-record.started;await writeReport();
  }catch(error){if(record){record.status=502;record.error=error.name==='TimeoutError'?'Real model timeout':'Real model request failed';record.ms=Date.now()-record.started;await writeReport().catch(()=>{});}if(res.headersSent)res.end();else{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.name==='TimeoutError'?'Real model timeout':'Real model request failed'}}));}}
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const shellTool={name:'run_shell',description:'在隔离任务中实际运行 Windows PowerShell 5.1（默认）或 pwsh。只允许 Write-Output 输出常量与串联，不执行文件修改或其他命令。返回实际退出码与输出。',inputSchema:{type:'object',properties:{command:{type:'string'},shell:{type:'string',enum:['windows-powershell','pwsh']}},required:['command']}};
const mcp=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const parts=[];for await(const p of req)parts.push(p);const input=JSON.parse(Buffer.concat(parts));
  if(input.id===undefined){res.writeHead(202);res.end();return;}
  let result;
  if(input.method==='initialize')result={protocolVersion:input.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'Isolated real shell',version:'1'}};
  else if(input.method==='tools/list')result={tools:[shellTool]};
  else if(input.method==='tools/call'){
    const {command,shell='windows-powershell'}=input.params.arguments||{};
    if(input.params.name!=='run_shell'||typeof command!=='string'||command.length>300||!/^Write-Output\s+['"][a-z0-9 -]+['"](?:\s*(?:;|&&|\r?\n)\s*Write-Output\s+['"][a-z0-9 -]+['"])*\s*$/i.test(command))result={isError:true,content:[{type:'text',text:'隔离工具只允许 Write-Output 常量及串联，不接受其他命令。'}]};
    else{
      const call={case:caseName,command,shell,started:Date.now()};shellCalls.push(call);
      const proc=spawn(shell==='pwsh'?'pwsh.exe':'powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';proc.stdout.on('data',c=>stdout+=c);proc.stderr.on('data',c=>stderr+=c);
      const code=await new Promise(r=>{proc.on('error',()=>r(-1));proc.on('close',r);});Object.assign(call,{code,stdout:stdout.trim(),stderr:stderr.trim(),ms:Date.now()-call.started});
      result={isError:code!==0,content:[{type:'text',text:JSON.stringify({shell,exitCode:code,stdout:call.stdout,stderr:call.stderr})}]};await writeReport();
    }
  }else result={};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result}));
});await new Promise(r=>mcp.listen(0,'127.0.0.1',r));

const data=join(root,'profile'),workspace=join(root,'project-a'),other=join(root,'project-b'),vault=join(root,'vault');
await Promise.all([mkdir(data),mkdir(workspace),mkdir(other),mkdir(vault)]);
await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[{...provider,baseUrl:`http://127.0.0.1:${proxy.address().port}/v1`,models:[{...selected,maxTokens:2400}]}]},credentials:{[provider.id]:settings.credentials[provider.id]},security:{approval:'auto',access:'full'},capabilities:{skills:[],vaultPath:null,webEnabled:false,browserEnabled:false},memoryEnabled:{l1:false,l2:false,l3:false,work:true},mcp:[{id:'acceptance-shell',name:'隔离真实命令',transport:'http',url:`http://127.0.0.1:${mcp.address().port}/mcp`,enabled:true}]}));
await writeFile(join(data,'app-state.json'),JSON.stringify({provider:provider.id,modelId:selected.id,projectPath:workspace}));
let seq=0;
async function start(){
  const child=spawn(process.execPath,[bridgePath],{cwd:workspace,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:workspace},stdio:['pipe','pipe','pipe']});
  const seen=[],waiters=new Set();let stderr='';child.stderr.on('data',c=>stderr+=c);
  createInterface({input:child.stdout}).on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}seen.push(event);for(const w of [...waiters])if(w.p(event)){waiters.delete(w);clearTimeout(w.timer);w.resolve(event);}});
  const until=(p,timeout=maxCaseMs)=>{const match=seen.find(p);if(match)return Promise.resolve(match);return new Promise((resolve,reject)=>{const w={p,resolve};w.timer=setTimeout(()=>{waiters.delete(w);reject(Error('隔离Agent等待超时'));},timeout);waiters.add(w);});};
  child.on('exit',()=>{for(const w of waiters){clearTimeout(w.timer);w.resolve({type:'error',message:'隔离Agent退出'});}waiters.clear();});
  bridge={child,seen,until,async command(type,args={},timeout=maxCaseMs){const id='real-'+(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');const event=await until(m=>m.id===id&&['ack','done','error','goals'].includes(m.type),timeout);if(event.type==='error')throw Error(event.message);return event;}};
  await until(m=>m.type==='ready',30000);await bridge.command('init');await bridge.command('set_thinking_level',{level:'low'});
}
async function stop(){if(!bridge)return;const {child}=bridge;bridge=null;const closed=once(child,'close');child.stdin.end();const timer=setTimeout(()=>child.kill(),10000);await closed;clearTimeout(timer);}
async function prompt(name,text,{continueOnError=false,timeoutMs=maxCaseMs}={}){
  caseName=name;const begin=Date.now(),index=bridge.seen.length,startRequest=requests.length,startCalls=shellCalls.length;
  console.log('START '+name);let outcome,error;try{outcome=await bridge.command('prompt',{text},timeoutMs);}catch(e){error=e;}
  const events=bridge.seen.slice(index);const item={name,ms:Date.now()-begin,prompt:text,outcome:outcome?.outcome,error:error?.message,text:events.filter(e=>e.type==='delta'&&e.kind!=='thinking').map(e=>e.text).join(''),thinkingCharacters:events.filter(e=>e.type==='delta'&&e.kind==='thinking').reduce((n,e)=>n+(e.text?.length||0),0),toolStarts:events.filter(e=>e.type==='tool_start').map(e=>({name:e.name,args:e.args})),toolResults:events.filter(e=>e.type==='tool_end'),requestStart:startRequest,shellStart:startCalls};cases.push(item);console.log('DONE '+name+' '+item.ms+'ms');await writeReport();if(error&&!continueOnError)throw error;return item;
}
async function waitWork(){
  const end=Date.now()+50000;while(Date.now()<end){let memory;try{memory=JSON.parse(await readFile(join(data,'memory.json'),'utf8'));}catch{}if(memory?.working?.length)return memory;await new Promise(r=>setTimeout(r,500));}return null;
}
async function captureProfileSnapshot(name){
  const read=async file=>{try{return JSON.parse(await readFile(join(data,file),'utf8'));}catch{return null;}};
  report.profileSnapshots||={};report.profileSnapshots[name]={memory:await read('memory.json'),learner:await read('learner.json')};await writeReport();
}
async function resilientPrompt(name,text,snapshotName){
  if(Date.now()-suiteStarted>=maxSuiteMs){const item={name,status:'skipped',error:'suite time budget exceeded',ms:0};cases.push(item);await writeReport();return item;}
  const remaining=maxSuiteMs-(Date.now()-suiteStarted),item=await prompt(name,text,{continueOnError:true,timeoutMs:Math.min(maxCaseMs,remaining)});
  item.status=item.error?'failed':item.outcome?.status==='complete'?'complete':'incomplete';
  if(snapshotName)await captureProfileSnapshot(snapshotName);
  if(item.status!=='complete'&&Date.now()-suiteStarted<maxSuiteMs-30000){await stop().catch(()=>{});await start();await bridge.command('new_session');}
  await writeReport();
  return item;
}
async function runNotesProfile(){
  const includeNotes=suite==='notes-profile';
  if(includeNotes){await writeFile(join(vault,'特征分解.md'),'# 特征分解\n\n本学习组把特征向量称为“定向杆”。我们的独有约定：每轮先画两支定向杆，再用紫色标注对应的伸缩倍率。验收口令：青铜海燕。\n');await writeFile(join(vault,'Reed-笔记库总览.md'),'# 总览\n数学：特征分解.md，包含特征向量与本学习组的绘图约定。\n');}
  await start();await bridge.command('save_role',{roleId:'agent',name:'验收 Agent',system:'你是隔离验证 Agent，使用工具获得真实结果，回答简短。',learnerProfileEnabled:true});
  await bridge.command('memory_enabled',{layer:'l1',enabled:true});if(includeNotes)await bridge.command('configure_capabilities',{vaultPath:vault});await bridge.command('new_session');
  if(includeNotes){const note=await resilientPrompt('notes-paraphrase','根据我的笔记，讲讲 eigenvectors 的图示约定。请给出我们学习组规定的作图顺序、颜色和验收口令，引用笔记原文，不要用通用知识猜。','after-notes');report.noteChecks={usedSearchTool:note.toolStarts?.some(t=>t.name==='search_notes'),mentionsSequence:/先画两支定向杆/.test(note.text||''),mentionsColor:/紫色/.test(note.text||''),mentionsToken:/青铜海燕/.test(note.text||''),hasSourceCitation:/特征分解\.md/.test(note.text||''),hasVerbatimEvidence:/每轮先画两支定向杆，再用紫色标注对应的伸缩倍率/.test(note.text||'')};await writeReport();if(!bridge)await start();else await bridge.command('new_session');}
  if(suite==='profile-correction'){await captureProfileSnapshot('after-profile-original');report.originalSeed='synthetic fixture; not naturally learned';}
  else await resilientPrompt('profile-original','请把这条长期回答顺序偏好记录到学习画像，调用 record_learning_event，kind=preference，subject=回答顺序，detail=先给结论，再解释原理，evidence必须引用我刚才说的原话：“先给结论，再解释原理”。保存后确认。','after-profile-original');
  if(!bridge)await start();else await bridge.command('new_session');
  await resilientPrompt('profile-correction','纠正学习画像中的回答顺序偏好。请调用 record_learning_event，以 operation=replace、targetSubject=回答顺序、kind=preference、subject=回答顺序，detail=先讲原理，再给结论；evidence 必须逐字引用我这句话：“今后先讲原理，再给结论，旧偏好已经不适用”。确认已替换。','after-profile-correction');
  await stop();if(Date.now()-suiteStarted<maxSuiteMs-30000){await start();await bridge.command('new_session');await resilientPrompt('profile-after-restart','按照我当前的讲解偏好，用两句话解释矩阵乘法。','after-profile-restart');}
  const snap=report.profileSnapshots||{},preferences=state=>state?.preferences||state?.events?.filter(e=>e.kind==='preference')||[],original=JSON.stringify(preferences(snap['after-profile-original']?.learner)),corrected=JSON.stringify(preferences(snap['after-profile-correction']?.learner)),afterRestart=JSON.stringify(preferences(snap['after-profile-restart']?.learner)),answer=cases.find(c=>c.name==='profile-after-restart')?.text||'';
  report.profileChecks={originalSaved:/先给结论，再解释原理/.test(original),correctionSaved:/先讲原理，再给结论/.test(corrected),correctedPreferenceAfterRestart:/先讲原理，再给结论/.test(afterRestart),oldPreferenceStillCurrent:/先给结论，再解释原理/.test(afterRestart),answerBeginsWithPrinciple:/先讲原理|原理/.test(answer.trim().slice(0,100)),answerMentionsConclusion:/结论/.test(answer)};await writeReport();
}
async function run(){
  const seedIndex=process.argv.indexOf('--continue-from');
  if(['notes-profile','profile-only','profile-correction'].includes(suite)){
    if(suite==='profile-correction')await writeFile(join(data,'learner.json'),JSON.stringify({version:1,events:[{id:'synthetic-original',kind:'preference',subject:'回答顺序',detail:'先给结论，再解释原理',evidence:'先给结论，再解释原理',operation:'supplement',source:'synthetic-fixture',time:new Date().toISOString()}]}));
    await runNotesProfile();return;
  }
  if(seedIndex>=0){const seed=JSON.parse(await readFile(resolve(process.argv[seedIndex+1]),'utf8'));assert.ok(seed.learned?.length,'缺少已验证训练产物');report.learned=seed.learned.map(i=>({...i,...(i.scope?{scope:workspace}:{})}));report.seededFrom=resolve(process.argv[seedIndex+1]);await writeFile(join(data,'memory.json'),JSON.stringify({enabled:{l1:false,l2:false,l3:false,work:true},profile:'',facts:[],notes:[],working:report.learned}));}
  await start();
  if(!report.seededFrom){
  const training=await prompt('train-real-error',"请用 MCP 隔离真实命令工具复现并修正一个现有命令：先执行 Write-Output 'amber' && Write-Output 'violet'（默认解释器），根据实际报错修正，确保两段都输出。只处理这个任务。确认有效后请记住可复用的修正；如当前轮无法保存，请明确说明，别声称已经记住。");
  const learned=training.outcome?.status==='complete'?await waitWork():null;report.learned=learned?.working||[];await writeReport();
  console.log('LEARNED '+(report.learned.length));
  }
  await stop();assert.ok(report.learned.length,'真实工具修正完成，但未形成持久经验');if(process.argv.includes('--train-only'))return;
  await start();await bridge.command('new_session');await bridge.command('memory_enabled',{layer:'work',enabled:false});
  const repeatPrompt='请用本项目的默认解释器，依次输出 amber 和 violet，两段都要执行。给出实际输出。';
  await prompt('restart-memory-off',repeatPrompt);
  await bridge.command('new_session');await bridge.command('memory_enabled',{layer:'work',enabled:true});
  await prompt('restart-memory-on',repeatPrompt);
  await bridge.command('new_session');
  await prompt('different-environment','这次明确使用 pwsh，依次输出 amber 和 violet。调用工具真实验证；不要把其他解释器的限制说成 pwsh 的限制。');
  await bridge.command('new_session');
  await prompt('save-project-workflow','请实际用默认解释器依次输出 amber 和 violet 并核对结果。这是本项目长期的颜色输出验收流程，请保存为 kind=workflow、仅本项目适用的经验；正文保留 amber 和 violet，evidence仅引用一段工具原文，不添加未执行的分支。');
  const scopedMemory=JSON.parse(await readFile(join(data,'memory.json'),'utf8'));report.projectExperienceIds=scopedMemory.working.filter(i=>i.scope===workspace).map(i=>i.id);
  await bridge.command('change_workspace',{path:other});
  await prompt('project-b-boundary',repeatPrompt);
  await bridge.command('change_workspace',{path:workspace});
  await prompt('project-a-restored',repeatPrompt);
  await bridge.command('new_session');
  await prompt('correct-work-method',`请先用默认解释器实际运行两条换行分隔的命令（第一行 Write-Output 'amber'，第二行 Write-Output 'violet'）。成功后将经验 ${report.learned[0].id} 用 operation=replace 纠正为“本任务用换行串联”，kind=shell；仅记录这次真正验证的步骤，不添加条件分支。旧分号方法保留在历史，不混入当前推荐步骤。evidence逐字引用一段工具原文。`);
  report.correctedMemory=JSON.parse(await readFile(join(data,'memory.json'),'utf8'));await stop();await start();await bridge.command('new_session');
  await prompt('work-correction-after-restart',repeatPrompt);
  await bridge.command('save_role',{roleId:'agent',name:'验收 Agent',system:'你是隔离验证 Agent，使用工具获得真实结果，回答简短。',learnerProfileEnabled:true});
  await bridge.command('memory_enabled',{layer:'l1',enabled:true});
  await writeFile(join(vault,'特征分解.md'),'# 特征分解\n\n本学习组把特征向量称为“定向杆”。我们的独有约定：每轮先画两支定向杆，再用紫色标注对应的伸缩倍率。验收口令：青铜海燕。\n');
  await writeFile(join(vault,'Reed-笔记库总览.md'),'# 总览\n数学：特征分解.md，包含特征向量与本学习组的绘图约定。\n');
  await bridge.command('configure_capabilities',{vaultPath:vault});await bridge.command('new_session');
  await prompt('notes-paraphrase','根据我的笔记，讲讲 eigenvectors 的图示约定。请给出我们学习组规定的作图顺序、颜色和验收口令，引用笔记原文，不要用通用知识猜。');
  await prompt('profile-original','请记住我的长期讲解偏好：先给结论，再解释原理。请通过保存工具确认。');
  await prompt('profile-correction','纠正我之前的长期讲解偏好：今后先讲原理，再给结论，旧偏好已经不适用。请替换已有主题并通过保存工具确认。');
  await stop();await start();await bridge.command('new_session');
  await prompt('profile-after-restart','按照我当前的讲解偏好，用两句话解释矩阵乘法。');
  await writeReport();
}
try{await run();}catch(error){report.failure=String(error.message).slice(0,600);await writeReport();console.log('VALIDATION FAILED: '+report.failure);process.exitCode=1;}
finally{await stop().catch(()=>{});try{report.finalMemory=JSON.parse(await readFile(join(data,'memory.json'),'utf8'));}catch{}try{report.usage=(await readFile(join(data,'work-usage.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}catch{}proxy.closeAllConnections();mcp.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>mcp.close(r))]);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});await writeReport();console.log('REPORT '+reportPath);}
