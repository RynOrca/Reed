// Opt-in real-provider acceptance. Only synthetic tasks and temporary profiles are sent.
import {access,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const artifacts=join(project,'dist','real-memory-acceptance');await mkdir(artifacts,{recursive:true});
function option(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
const helperEffort=option('--helper-effort')||'low';assert.ok(['low','none','configured'].includes(helperEffort),'辅助思考只允许low、none或保留配置');
const suite=option('--suite')||'full';assert.ok(['full','notes-profile','profile-only','profile-correction','work-shell','work-pwsh','work-scope','work-update','work-replace','work-learn','notes-only','learning-study','learning-review','latency'].includes(suite),`未知验收套件：${suite}`);
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
const boundedSuite=suite!=='full',suiteStarted=Date.now(),maxSuiteMs=boundedSuite?360000:Infinity,maxCaseMs=boundedSuite?115000:150000,maxUpstreamMs=boundedSuite?60000:120000,maxRequestsPerCase=suite==='work-learn'?10:suite.startsWith('work-')?8:boundedSuite?5:12,maxSuiteRequests=boundedSuite?18:Infinity;
const report={suite,bridgePath,model:selected.id,thinking:'low',helperThinking:helperEffort,thinkingCeiling:'medium',outputLimit:2400,syntheticOnly:true,root,cases,requests,shellCalls,requestBudget:{maxSuiteMs:Number.isFinite(maxSuiteMs)?maxSuiteMs:null,maxCaseMs,maxUpstreamMs,maxRequestsPerCase:Number.isFinite(maxRequestsPerCase)?maxRequestsPerCase:null,maxSuiteRequests:Number.isFinite(maxSuiteRequests)?maxSuiteRequests:null}};
report.sourceSha256={};for(const name of ['bridge.mjs','work-applicability.mjs','work-memory.mjs','work-recall.mjs','memory-value.mjs','auxiliary-runtime.mjs','learner.mjs','memory-agent.mjs','role-features.mjs','role-skills.mjs','capabilities.mjs','note-retrieval.mjs']){try{report.sourceSha256[name]=createHash('sha256').update(await readFile(join(dirname(bridgePath),name))).digest('hex');}catch{}}
report.sourceSha256['learning-tools.mjs']=createHash('sha256').update(await readFile(join(dirname(bridgePath),'learning-tools.mjs'))).digest('hex');
let reportWrites=Promise.resolve();const writeReport=()=>{const snapshot=JSON.stringify(report,null,2);reportWrites=reportWrites.catch(()=>{}).then(()=>writeFile(reportPath,snapshot));return reportWrites;};
function classify(system){return /工作经验整理器/.test(system)?'experience_extract':/记忆价值审查器/.test(system)?'value_gate':/判断新增记忆/.test(system)?'deduplicate':/为工作经验检索/.test(system)?'work_expand':/个人笔记检索规划器/.test(system)?'note_expand':/笔记库导航整理器|根据分批笔记浏览结果/.test(system)?'overview':'agent';}
const helperKinds=new Set(['value_gate','work_expand','note_expand','experience_extract','deduplicate']);
const proxy=createServer(async(req,res)=>{
  let record,streamComplete=false,reviewBytes=0;const reviewChunks=[],upstream=new AbortController();
  const cancel=()=>{if(!res.writableEnded)upstream.abort();};req.once('aborted',cancel);res.once('close',cancel);
  try{
    if(req.method!=='POST'||!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
    const chunks=[];for await(const c of req)chunks.push(c);const input=JSON.parse(Buffer.concat(chunks));
    const system=input.messages.filter(m=>['system','developer'].includes(m.role)).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');
    const requestedEffort=input.reasoning_effort??null;input.reasoning_effort=helperKinds.has(classify(system))?(helperEffort==='configured'?(['none','minimal','low','medium'].includes(requestedEffort)?requestedEffort:'low'):helperEffort):'low';const requestCase=caseName;
    record={case:requestCase,kind:classify(system),system,model:input.model,requestedEffort,effectiveEffort:input.reasoning_effort,started:Date.now(),tools:(input.tools||[]).map(t=>t.function?.name),recentToolResults:input.messages.filter(m=>m.role==='tool').slice(-2).map(m=>({name:m.name,content:typeof m.content==='string'?m.content.slice(0,2500):JSON.stringify(m.content).slice(0,2500)}))};requests.push(record);await writeReport();
    const caseCount=requests.filter(r=>r.case===requestCase).length;
    if(caseCount>maxRequestsPerCase||requests.length>maxSuiteRequests||Date.now()-suiteStarted>maxSuiteMs){record.status=429;record.budgetExceeded=true;res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Isolated acceptance request/time budget exceeded'}}));return;}
    const response=await fetch(provider.baseUrl.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(req.headers.authorization?{authorization:req.headers.authorization}:{})},body:JSON.stringify(input),signal:AbortSignal.any([AbortSignal.timeout(maxUpstreamMs),upstream.signal])});
    record.status=response.status;res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});
    for await(const chunk of response.body){if(helperKinds.has(record.kind)&&reviewBytes<65536){reviewChunks.push(Buffer.from(chunk));reviewBytes+=chunk.length;}res.write(chunk);}
    streamComplete=true;res.end();
  }catch(error){
    if(record){record.clientCancelled=upstream.signal.aborted;record.proxyStatus=record.clientCancelled?499:502;record.status??=record.proxyStatus;record.error=record.clientCancelled?'Isolated agent cancelled request':error.name==='TimeoutError'?'Real model timeout':'Real model request failed';const code=error.cause?.code||error.code;if(typeof code==='string'&&/^[A-Z0-9_]{1,60}$/.test(code))record.errorCode=code;}
    if(!res.destroyed){if(res.headersSent)res.end();else{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Isolated upstream request did not complete'}}));}}
  }finally{
    req.removeListener('aborted',cancel);res.removeListener('close',cancel);
    if(record){
      record.ms=Date.now()-record.started;record.finished=Date.now();record.streamComplete=streamComplete;
      if(helperKinds.has(record.kind)){
        const raw=Buffer.concat(reviewChunks).toString('utf8'),parts=[];
        if(raw.trim().startsWith('{'))try{parts.push(JSON.parse(raw));}catch{}
        else for(const line of raw.split('\n'))if(line.startsWith('data: ')&&line.slice(6).trim()!=='[DONE]')try{parts.push(JSON.parse(line.slice(6)));}catch{}
        record.helperOutput={text:parts.flatMap(p=>(p.choices||[]).map(c=>c.delta?.content||c.message?.content||'')).join(''),finishReasons:parts.flatMap(p=>(p.choices||[]).map(c=>c.finish_reason).filter(Boolean)),usage:parts.findLast(p=>p.usage)?.usage,captureTruncated:reviewBytes>65536,partial:!streamComplete};
        record.reviewOutput=record.helperOutput;
      }
      await writeReport().catch(()=>{});
    }
  }
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
    if(input.params.name!=='run_shell'||typeof command!=='string'||command.length>300||!/^Write-Output\s+(?:['"][a-z0-9 -]+['"]|[a-z][a-z0-9]*)(?:\s*(?:;|&&|\r?\n)\s*Write-Output\s+(?:['"][a-z0-9 -]+['"]|[a-z][a-z0-9]*))*\s*$/i.test(command))result={isError:true,content:[{type:'text',text:'隔离工具只允许 Write-Output 常量及串联，不接受其他命令。'}]};
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
  createInterface({input:child.stdout}).on('line',line=>{let event;try{event=JSON.parse(line);}catch{return;}event.observedAt=Date.now();seen.push(event);for(const w of [...waiters])if(w.p(event)){waiters.delete(w);clearTimeout(w.timer);w.resolve(event);}});
  const until=(p,timeout=maxCaseMs)=>{const match=seen.find(p);if(match)return Promise.resolve(match);return new Promise((resolve,reject)=>{const w={p,resolve};w.timer=setTimeout(()=>{waiters.delete(w);reject(Error('隔离Agent等待超时'));},timeout);waiters.add(w);});};
  child.on('exit',()=>{for(const w of waiters){clearTimeout(w.timer);w.resolve({type:'error',message:'隔离Agent退出'});}waiters.clear();});
  bridge={child,seen,until,async command(type,args={},timeout=maxCaseMs){const id='real-'+(++seq);child.stdin.write(JSON.stringify({id,type,...args})+'\n');const event=await until(m=>m.id===id&&['ack','done','error','goals'].includes(m.type),timeout);if(event.type==='error')throw Error(event.message);return event;}};
  await until(m=>m.type==='ready',30000);await bridge.command('init');await bridge.command('set_thinking_level',{level:'low'});
}
async function stop(){if(!bridge)return;const {child}=bridge;bridge=null;const closed=once(child,'close');child.stdin.end();const timer=setTimeout(()=>child.kill(),10000);await closed;clearTimeout(timer);}
async function prompt(name,text,{continueOnError=false,timeoutMs=maxCaseMs}={}){
  caseName=name;const begin=Date.now(),index=bridge.seen.length,startRequest=requests.length,startCalls=shellCalls.length;
  console.log('START '+name);let outcome,error;try{outcome=await bridge.command('prompt',{text},timeoutMs);}catch(e){error=e;}
  const events=bridge.seen.slice(index);const first=p=>{const e=events.find(p);return e?e.observedAt-begin:null;};const item={name,ms:Date.now()-begin,prompt:text,outcome:outcome?.outcome,error:error?.message,text:events.filter(e=>e.type==='delta'&&e.kind!=='thinking').map(e=>e.text).join(''),thinkingCharacters:events.filter(e=>e.type==='delta'&&e.kind==='thinking').reduce((n,e)=>n+(e.text?.length||0),0),toolStarts:events.filter(e=>e.type==='tool_start').map(e=>({name:e.name,args:e.args})),toolResults:events.filter(e=>e.type==='tool_end'),requestStart:startRequest,shellStart:startCalls,timing:{firstKnowledgeStatusMs:first(e=>e.type==='knowledge_progress'),firstThinkingMs:first(e=>e.type==='delta'&&e.kind==='thinking'&&e.text),firstVisibleTextMs:first(e=>e.type==='delta'&&e.kind!=='thinking'&&e.text),firstToolMs:first(e=>e.type==='tool_start')},knowledgeProgress:events.filter(e=>e.type==='knowledge_progress').map(e=>({phase:e.phase,count:e.count,ms:e.observedAt-begin}))};cases.push(item);console.log('DONE '+name+' '+item.ms+'ms');await writeReport();if(error&&!continueOnError)throw error;return item;
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
  const includeNotes=['notes-profile','notes-only'].includes(suite);
  if(includeNotes){await writeFile(join(vault,'特征分解.md'),'# 特征分解\n\n本学习组把特征向量称为“定向杆”。我们的独有约定：每轮先画两支定向杆，再用紫色标注对应的伸缩倍率。验收口令：青铜海燕。\n');await writeFile(join(vault,'Reed-笔记库总览.md'),'# 总览\n数学：特征分解.md，包含特征向量与本学习组的绘图约定。\n');}
  await start();await bridge.command('save_role',{roleId:'agent',name:'验收 Agent',system:'你是隔离验证 Agent，使用工具获得真实结果，回答简短。',learnerProfileEnabled:true});
  await bridge.command('memory_enabled',{layer:'l1',enabled:true});if(includeNotes)await bridge.command('configure_capabilities',{vaultPath:vault});await bridge.command('new_session');
  if(includeNotes){const note=await resilientPrompt('notes-paraphrase',suite==='notes-only'?'According to my personal notes, what are the drawing order, highlight colour and verification phrase for eigenvectors? Find and cite the original note; do not guess from general knowledge.':'根据我的笔记，讲讲 eigenvectors 的图示约定。请给出我们学习组规定的作图顺序、颜色和验收口令，引用笔记原文，不要用通用知识猜。','after-notes');report.noteChecks={usedSearchTool:note.toolStarts?.some(t=>t.name==='search_notes'),mentionsSequence:/先画两支定向杆/.test(note.text||''),mentionsColor:/紫色/.test(note.text||''),mentionsToken:/青铜海燕/.test(note.text||''),hasSourceCitation:/特征分解\.md/.test(note.text||''),hasVerbatimEvidence:/每轮先画两支定向杆，再用紫色标注对应的伸缩倍率/.test(note.text||'')};await writeReport();if(!bridge)await start();else await bridge.command('new_session');}
  if(suite==='notes-only')return;
  if(suite==='profile-correction'){await captureProfileSnapshot('after-profile-original');report.originalSeed='synthetic fixture; not naturally learned';}
  else await resilientPrompt('profile-original','请把这条长期回答顺序偏好记录到学习画像，调用 record_learning_event，kind=preference，subject=回答顺序，detail=先给结论，再解释原理，evidence必须引用我刚才说的原话：“先给结论，再解释原理”。保存后确认。','after-profile-original');
  if(!bridge)await start();else await bridge.command('new_session');
  await resilientPrompt('profile-correction','纠正学习画像中的回答顺序偏好。请调用 record_learning_event，以 operation=replace、targetSubject=回答顺序、kind=preference、subject=回答顺序，detail=先讲原理，再给结论；evidence 必须逐字引用我这句话：“今后先讲原理，再给结论，旧偏好已经不适用”。确认已替换。','after-profile-correction');
  await stop();if(Date.now()-suiteStarted<maxSuiteMs-30000){await start();await bridge.command('new_session');await resilientPrompt('profile-after-restart','按照我当前的讲解偏好，用两句话解释矩阵乘法。','after-profile-restart');}
  const snap=report.profileSnapshots||{},preferences=state=>state?.preferences||state?.events?.filter(e=>e.kind==='preference')||[],original=JSON.stringify(preferences(snap['after-profile-original']?.learner)),corrected=JSON.stringify(preferences(snap['after-profile-correction']?.learner)),afterRestart=JSON.stringify(preferences(snap['after-profile-restart']?.learner)),answer=cases.find(c=>c.name==='profile-after-restart')?.text||'';
  report.profileChecks={originalSaved:/先给结论，再解释原理/.test(original),correctionSaved:/先讲原理，再给结论/.test(corrected),correctedPreferenceAfterRestart:/先讲原理，再给结论/.test(afterRestart),oldPreferenceStillCurrent:/先给结论，再解释原理/.test(afterRestart),answerBeginsWithPrinciple:/先讲原理|原理/.test(answer.trim().slice(0,100)),answerMentionsConclusion:/结论/.test(answer)};await writeReport();
}
const legacyId='fixture-legacy-output',projectId='fixture-project-workflow';
async function seedWork(items){
  const now=new Date().toISOString();
  report.workSeed={basis:'synthetic fixture, not natural learning',ids:items.map(i=>i.id)};
  await writeFile(join(data,'memory.json'),JSON.stringify({enabled:{l1:false,l2:false,l3:false,work:true},profile:'',facts:[],notes:[],working:items.map(i=>({status:'active',revision:1,revisions:[],source:'synthetic-fixture',updated:now,...i}))}));
}
const legacyFixture=()=>({id:legacyId,kind:'shell',title:'Windows PowerShell 5.1 两条输出',body:'Windows PowerShell 5.1 用分号顺序输出 amber 与 violet，不适用于 pwsh 的语法限制判断。',trigger:'默认解释器输出 amber violet',environment:'powershell-legacy',steps:"Write-Output 'amber'; Write-Output 'violet'",validatedCommands:["Write-Output 'amber'; Write-Output 'violet'"],verificationScope:'synthetic-fixture'});
async function workSetup(){await start();await bridge.command('save_role',{roleId:'agent',name:'隔离验收 Agent',system:'你是隔离验收助手。只处理当前明确任务，用指定工具获得真实结果；无需浏览目录或读取配置。经验仅作参考，先核对当前环境。回答简短，保存失败要如实报告。',learnerProfileEnabled:false});await bridge.command('new_session');}
async function captureWork(name){
  let memory=null;try{memory=JSON.parse(await readFile(join(data,'memory.json'),'utf8'));}catch{}
  report.workSnapshots||={};report.workSnapshots[name]=memory;await writeReport();return memory;
}
function agentRequests(name){return requests.filter(r=>r.case===name&&r.kind==='agent');}
function returnedWorkItems(name){return (cases.find(c=>c.name===name)?.toolResults||[]).flatMap(t=>(t.result?.content||[]).flatMap(b=>{if(b.type!=='text')return [];try{const value=JSON.parse(b.text);return Array.isArray(value)?value:[];}catch{return [];}}));}
function outputPairExecuted(name,shell){const output=shellCalls.filter(c=>c.case===name&&c.shell===shell&&c.code===0).map(c=>c.stdout).join('\n');return output.includes('amber')&&output.indexOf('violet')>output.indexOf('amber');}
async function runWorkSuite(){
  if(suite==='work-learn'){
    await workSetup();
    await resilientPrompt('natural-work-learning',"请通过 MCP run_shell 在默认 Windows PowerShell 5.1 中，先实际执行 Write-Output 'amber' && Write-Output 'violet'，根据真实报错修正，确认两段都输出。这类命令任务以后会重复使用，完成后简短报告实际输出。");
    const stored=await waitWork();report.learned=stored?.working||[];await captureWork('after-natural-learning');
    if(report.learned.length){await stop();await start();await bridge.command('new_session');await resilientPrompt('natural-work-repeat','请用本项目的默认 Windows PowerShell 5.1 解释器，通过 MCP run_shell 依次输出 amber 和 violet。给出实际输出。');}
    const id=report.learned[0]?.id;
    report.workChecks={freshProfileNoFixture:true,actualFailureObserved:shellCalls.some(c=>c.case==='natural-work-learning'&&c.code!==0),actualFixObserved:outputPairExecuted('natural-work-learning','windows-powershell'),experiencePersisted:!!id,commandsFromSuccessfulExecution:report.learned.length>0&&report.learned.every(i=>i.validatedCommands?.length&&i.validatedCommands.every(cmd=>shellCalls.some(c=>c.case==='natural-work-learning'&&c.code===0&&c.command.trim()===cmd.trim()))),recallSurvivesRestart:!!id&&agentRequests('natural-work-repeat').some(r=>r.system.includes(id)),repeatActualSuccess:outputPairExecuted('natural-work-repeat','windows-powershell'),repeatHasNoShellFailure:shellCalls.filter(c=>c.case==='natural-work-repeat').length>0&&shellCalls.filter(c=>c.case==='natural-work-repeat').every(c=>c.code===0)};
    await writeReport();return;
  }
  if(suite==='work-scope')await seedWork([{id:projectId,kind:'workflow',scope:workspace,title:'颜色输出验收流程',body:'本项目颜色输出验收流程：依次输出 amber 和 violet，项目标记 scope-canary-olive。',trigger:'颜色输出验收流程',steps:"Write-Output 'amber'; Write-Output 'violet'",verificationScope:'synthetic-fixture'}]);
  else await seedWork([legacyFixture()]);
  await workSetup();
  if(['work-shell','work-pwsh'].includes(suite)){
    await resilientPrompt('pwsh-boundary','明确使用 pwsh，实际通过 MCP run_shell 依次输出 amber 和 violet；不要把 Windows PowerShell 5.1 的限制套到 pwsh。无需保存经验。');
    if(suite==='work-pwsh'){const core=agentRequests('pwsh-boundary');report.workChecks={noLegacyIdInEveryPwshRequest:core.length>0&&core.every(r=>!r.system.includes(legacyId)),pwshExecuted:outputPairExecuted('pwsh-boundary','pwsh')};await writeReport();return;}
    await stop();await start();await bridge.command('new_session');
    await resilientPrompt('legacy-after-restart','请用默认 Windows PowerShell 5.1 解释器通过 MCP run_shell 依次输出 amber 和 violet，核对实际输出。无需保存经验。');
    const core=agentRequests('pwsh-boundary'),legacy=agentRequests('legacy-after-restart');
    report.workChecks={pwshRequests:core.length,legacyRequests:legacy.length,noLegacyIdInEveryPwshRequest:core.length>0&&core.every(r=>!r.system.includes(legacyId)),legacyRecallAfterRestart:legacy.some(r=>r.system.includes(legacyId)),pwshExecuted:outputPairExecuted('pwsh-boundary','pwsh'),legacyExecuted:outputPairExecuted('legacy-after-restart','windows-powershell')};
  }else if(suite==='work-scope'){
    const task='请用 recall_memory(area=work, query=颜色输出验收流程) 查找当前项目的颜色输出验收流程，只报告是否找到及项目标记，不执行命令、不保存经验。';
    await resilientPrompt('scope-a',task);await bridge.command('change_workspace',{path:other});await bridge.command('new_session');
    await resilientPrompt('scope-b',task);await bridge.command('change_workspace',{path:workspace});await stop();await start();await bridge.command('new_session');
    await resilientPrompt('scope-a-restart',task);
    const a=agentRequests('scope-a'),b=agentRequests('scope-b'),restored=agentRequests('scope-a-restart');
    const resultText=name=>JSON.stringify(cases.find(c=>c.name===name)?.toolResults||[]);
    report.workChecks={projectAContext:a.some(r=>r.system.includes(projectId)),projectBNoContextLeak:b.length>0&&b.every(r=>!r.system.includes(projectId)&&!r.system.includes('scope-canary-olive')),projectARestoredContext:restored.some(r=>r.system.includes(projectId)),projectARecall:resultText('scope-a').includes(projectId),projectBNoToolLeak:!resultText('scope-b').includes(projectId)&&!resultText('scope-b').includes('scope-canary-olive'),projectARestoredRecall:resultText('scope-a-restart').includes(projectId),projectBRecallToolCalled:cases.find(c=>c.name==='scope-b')?.toolStarts?.some(t=>t.name==='recall_memory')||false};
  }else{
    await resilientPrompt('work-replace',`请先通过 MCP run_shell 使用默认 Windows PowerShell 5.1 实际执行两行命令：第一行 Write-Output 'amber'，第二行 Write-Output 'violet'。成功后调用 remember_work，以kind=shell、operation=replace、targetId=${legacyId}，将方法纠正为“本任务使用换行依次输出”，仅保存这次成功的命令并引用本轮证据收据。不要添加条件分支，不另存新条目。`);
    await captureWork('after-replace');await stop();await start();await bridge.command('new_session');
    await resilientPrompt('work-replace-restart',`请用 recall_memory(area=work,query=Windows PowerShell 输出) 读取当前经验 ${legacyId}，只报告当前步骤，不执行或保存。`);
    await captureWork('after-replace-restart');
    if(suite==='work-replace'){
      const changed=report.workSnapshots['after-replace']?.working?.find(i=>i.id===legacyId),restored=report.workSnapshots['after-replace-restart']?.working?.find(i=>i.id===legacyId);
      report.workChecks={replaced:changed?.revision>1&&changed?.revisions?.some(i=>i.operation==='replace'),replacementCommandsAreNewline:changed?.validatedCommands?.some(c=>c.includes('\n')&&!c.includes(';'))||false,replacementRemovesOldSemicolon:changed?.steps?!changed.steps.includes(';'):false,restartRestoresNewRevision:!!changed&&changed.revision>1&&restored?.revision===changed.revision,restartToolRecallsNewSteps:!!changed&&changed.revision>1&&returnedWorkItems('work-replace-restart').some(i=>i.id===legacyId&&i.steps===changed.steps&&i.revision>=changed.revision)};
      await writeReport();return;
    }
    await bridge.command('new_session');
    await resilientPrompt('work-invalidate',`请先用 MCP run_shell 在默认 Windows PowerShell 5.1 中真实执行两行输出 amber、violet 并核对成功。然后请记住此失效修正：这只是隔离测试输出，今后不再作为长期流程推荐。用 remember_work 的kind=shell、operation=invalidate、targetId=${legacyId} 标记失效，引用本轮成功工具收据，保留历史，不删除文件。`);
    await captureWork('after-invalidate');await stop();if(Date.now()-suiteStarted<maxSuiteMs-30000){await start();await bridge.command('new_session');await resilientPrompt('work-invalidate-restart','请用 recall_memory(area=work,query=Windows PowerShell 输出) 查当前有效经验，只报告找到的条目，不执行或保存。');}
    const changed=report.workSnapshots['after-replace']?.working?.find(i=>i.id===legacyId),invalid=report.workSnapshots['after-invalidate']?.working?.find(i=>i.id===legacyId);
    const later=agentRequests('work-invalidate-restart');
    report.workChecks={replaced:changed?.revision>1&&changed?.revisions?.some(i=>i.operation==='replace'),replacementCommandsAreNewline:changed?.validatedCommands?.some(c=>c.includes('\n')&&!c.includes(';'))||false,replacementRemovesOldSemicolon:changed?.steps?!changed.steps.includes(';'):false,restartRecallsReplacement:!!changed&&changed.revision>1&&returnedWorkItems('work-replace-restart').some(i=>i.id===legacyId&&i.steps===changed.steps&&i.revision>=changed.revision),invalidated:invalid?.status==='invalidated',historyRetained:invalid?.revisions?.length>=3,noInvalidIdAfterRestart:later.length>0&&later.every(r=>!r.system.includes(legacyId)),noInvalidIdInRecall:!JSON.stringify(cases.find(c=>c.name==='work-invalidate-restart')?.toolResults||[]).includes(legacyId),invalidationRecallToolCalled:cases.find(c=>c.name==='work-invalidate-restart')?.toolStarts?.some(t=>t.name==='recall_memory')||false};
  }
  await writeReport();
}
async function learningSetup(){
  await writeFile(join(vault,'特征分解.md'),'# 特征分解\n\n本学习组把特征向量称为“定向杆”。我们的独有约定：每轮先画两支定向杆，再用紫色标注对应的伸缩倍率。验收口令：青铜海燕。\n');
  await writeFile(join(vault,'Reed-笔记库总览.md'),'# 总览\n数学：特征分解.md，包含特征向量与本学习组绘图约定。\n');
  await start();await bridge.command('save_role',{roleId:'agent',name:'学习任务验收',system:'你是学习辅助助手。讲解使用原笔记证据并引用；只按用户明确陈述记录学习变化，不把提问或讲解结束当掌握。不绕过权限或用文件写入记忆。回答简短。',learnerProfileEnabled:true,skills:[]});
  await bridge.command('memory_enabled',{layer:'l1',enabled:true});await bridge.command('configure_capabilities',{vaultPath:vault});await bridge.command('new_session');
}
async function runLearningSuite(){
  if(suite==='learning-review'){
    const path=option('--learning-from');assert.ok(path,'复习阶段需要真实学习阶段报告');
    const previous=JSON.parse(await readFile(resolve(path),'utf8')),saved=previous.profileSnapshots?.['after-concept']?.learner;
    assert.ok(saved?.events?.some(e=>e.kind==='concept'),'学习阶段没有保存概念事件，不伪造复习前提');
    report.learningFrom=resolve(path);await writeFile(join(data,'learner.json'),JSON.stringify(saved));
  }
  await learningSetup();
  if(suite==='learning-study'){
    await resilientPrompt('learning-teach','请根据我的笔记讲解 eigenvectors 的作图约定，给出作图顺序、标注颜色与验收口令，并引用原笔记。','after-teach');
    await resilientPrompt('learning-record','我已经学过特征分解，但还不能独立解释。请用 record_learning_event 记录 kind=concept、subject=特征分解，detail=学过但尚未独立解释，需要复习；evidence逐字引用“我已经学过特征分解，但还不能独立解释”。不要推测掌握百分比。','after-concept');
    await stop();await start();await bridge.command('new_session');
    await resilientPrompt('learning-review-locked','请只调用 recall_memory(area=review,query=特征分解) 检查读取权限；本轮未绑定复习技能，不要自行加载技能或改角色，若被拒绝请如实报告。','after-review-locked');
    const before=report.profileSnapshots?.['after-teach']?.learner,learned=report.profileSnapshots?.['after-concept']?.learner,concept=learned?.knowledge?.find(i=>i.subject==='特征分解');
    const teach=cases.find(c=>c.name==='learning-teach'),locked=cases.find(c=>c.name==='learning-review-locked');
    report.learningChecks={teachingCitesOriginal:/特征分解\.md/.test(teach?.text||''),teachingUsesPersonalEvidence:/青铜海燕/.test(teach?.text||''),questionDidNotCreateConcept:!before?.knowledge?.length,conceptSaved:!!concept,masteryUnknown:concept?.mastery===null,needsReview:concept?.status==='needs_review',lockedReadAttempted:locked?.toolStarts?.some(t=>t.name==='recall_memory'&&t.args?.area==='review')||false,lockedReadRejected:locked?.toolResults?.some(t=>t.isError&&/先加载|不披露|不可用/.test(JSON.stringify(t.result)))||false,lockedReadNoConceptDetail:!JSON.stringify(locked?.toolResults||[]).includes('学过但尚未独立解释，需要复习')};
  }else{
    await bridge.command('save_role',{roleId:'agent',name:'学习任务验收',system:'你是学习辅助助手。遵循已加载复习技能，先问后答，不猜测掌握程度；不绕过权限或用文件写画像。回答简短。',learnerProfileEnabled:true,skills:[{skillId:'builtin-spaced-review',required:true}]});await bridge.command('new_session');
    await resilientPrompt('learning-review-question','请按 spaced-review 流程复习我学过的特征分解。先用 recall_memory(area=review,query=特征分解) 确认学习记录，结合原笔记只提出一个关于作图约定的回忆问题，等待我作答，先不要给出答案或验收口令。','after-review-question');
    await resilientPrompt('learning-review-answer','我的答案：先画两支定向杆，再用紫色标注对应的伸缩倍率，验收口令是青铜海燕。这次我独立回忆出来了。请根据原笔记评价，然后用 record_learning_event 保存 kind=review、subject=特征分解、result=independent，detail=独立回忆作图约定，evidence逐字引用“这次我独立回忆出来了”。只报告保存回执中的下次复习日期，不另算日期、不编造掌握百分比或已创建提醒。','after-review-answer');
    await stop();if(Date.now()-suiteStarted<maxSuiteMs-30000){await start();await bridge.command('new_session');await resilientPrompt('learning-review-restart','请继续复习特征分解，用 recall_memory(area=review,query=特征分解) 核对上次真实复习记录，报告记录是否存在和实际保存的下次复习日期，不出题、不保存。','after-review-restart');}
    const question=cases.find(c=>c.name==='learning-review-question'),after=report.profileSnapshots?.['after-review-answer']?.learner,restored=report.profileSnapshots?.['after-review-restart']?.learner;
    report.learningChecks={requiredReviewBodyLoaded:agentRequests('learning-review-question').some(r=>r.system.includes('必选流程：spaced-review')),reviewReadSucceeded:question?.toolResults?.some(t=>!t.isError&&JSON.stringify(t.result).includes('学过但尚未独立解释，需要复习'))||false,questionDidNotRevealCanary:!!question?.text&&!question.text.includes('青铜海燕'),reviewEventSaved:after?.events?.some(e=>e.kind==='review'&&e.subject==='特征分解')||false,masteryStillUnknown:after?.knowledge?.find(i=>i.subject==='特征分解')?.mastery===null,reviewEventSurvivesRestart:restored?.events?.some(e=>e.kind==='review'&&e.subject==='特征分解')||false};
    const {reviewDateChecks}=await import('./review-date-checks.mjs');
    Object.assign(report.learningChecks,reviewDateChecks(report));
  }
  await writeReport();
}
async function run(){
  if(suite==='latency'){
    await start();await bridge.command('save_role',{roleId:'agent',name:'响应速度验收',system:'你是学习辅助助手，回答简短。已有原文足够时直接引用，证据不足时主动查笔记，不编造，不保存记忆。',learnerProfileEnabled:false});await bridge.command('new_session');
    await resilientPrompt('latency-plain','只回答“收到”，不要使用工具或保存记忆。','latency-plain');
    await writeFile(join(vault,'特征分解.md'),'# 特征分解\n\n本学习组把特征向量称为“定向杆”。我们的独有约定：每轮先画两支定向杆，再用紫色标注对应的伸缩倍率。验收口令：青铜海燕。\n');await writeFile(join(vault,'Reed-笔记库总览.md'),'# 总览\n数学：特征分解.md，包含特征向量与本学习组的绘图约定。\n');
    await bridge.command('configure_capabilities',{vaultPath:vault});await bridge.command('new_session');
    await resilientPrompt('latency-local','根据我的特征分解笔记，简短回答作图顺序、标注颜色和验收口令，并引用原文。','latency-local');
    await bridge.command('new_session');await resilientPrompt('latency-paraphrase','According to my notes, give the drawing order, highlight colour and verification phrase for eigenvectors. Cite the original note, do not guess.','latency-paraphrase');
    report.latencySamples=cases.map(c=>({name:c.name,ms:c.ms,...c.timing,status:c.outcome?.status||c.status||'incomplete',requests:requests.filter(r=>r.case===c.name).length,failedRequests:requests.filter(r=>r.case===c.name&&r.status!==200).map(r=>({kind:r.kind,status:r.status,ms:r.ms})),hasEvidence:c.name==='latency-plain'?null:/特征分解\.md/.test(c.text)&&/紫色/.test(c.text)&&/青铜海燕/.test(c.text)}));await writeReport();return;
  }
  const seedIndex=process.argv.indexOf('--continue-from');
  if(suite.startsWith('learning-')){await runLearningSuite();return;}
  if(suite.startsWith('work-')){await runWorkSuite();return;}
  if(['notes-profile','profile-only','profile-correction','notes-only'].includes(suite)){
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
