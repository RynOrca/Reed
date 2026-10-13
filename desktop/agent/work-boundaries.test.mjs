import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkEvidenceLedger} from './work-evidence.mjs';
import {MemoryStore} from './memory.mjs';
import {applicableWork,workEnvironmentHint} from './work-applicability.mjs';
import {roleFeatureExtension} from './role-features.mjs';
import {createWorkRecaller} from './work-recall.mjs';

const output=(command,exitCode=0,shell='windows-powershell',name='run_shell')=>({toolName:'mcp_call',input:{serverId:'local',name,arguments:{command,shell}},content:[{type:'text',text:JSON.stringify({exitCode,shell,stdout:'amber\r\nviolet'})}],structuredContent:{preserve:true}});

test('证据收据只认可本轮成功命令，拒绝未执行分支、其他工具的结果和跨轮收据',()=>{
  const ledger=new WorkEvidenceLedger();
  const failed=ledger.add(output('invalid && command',1));
  const success=ledger.add(output("Write-Output 'amber'; Write-Output 'violet'"));
  const input={kind:'shell',title:'PowerShell 分号',body:'已观察两条命令顺序执行成功',evidenceIds:[success.id]};
  const prepared=ledger.prepare(input);
  assert.deepEqual(prepared.validatedCommands,[success.command]);assert.equal(prepared.steps,success.command);
  assert.equal(prepared.evidenceRefs[0].shell,'windows-powershell');
  assert.throws(()=>ledger.prepare({...input,body:'用 if ($LASTEXITCODE -eq 0) 判断'}),/未经执行/);
  assert.throws(()=>ledger.prepare({...input,validatedCommands:['other command']}),/未执行/);
  assert.throws(()=>ledger.prepare({...input,evidenceIds:[failed.id]}),/成功执行/);
  assert.throws(()=>new WorkEvidenceLedger().prepare(input),/不属于本轮/);
  const unrelated=ledger.add({toolName:'mcp_call',input:{name:'lookup'},content:[{type:'text',text:'Lookup succeeded'}]});
  assert.throws(()=>ledger.prepare({...input,evidenceIds:[unrelated.id]}),/成功执行/);
  const long=ledger.add(output('x'.repeat(701)));assert.throws(()=>ledger.prepare({...input,evidenceIds:[long.id]}),/长度上限/);
  const core=ledger.add(output('Write-Output core',0,'pwsh'));
  assert.throws(()=>ledger.prepare({...input,evidenceIds:[success.id,core.id]}),/必须拆成/);
  assert.throws(()=>ledger.prepare({...input,environment:'pwsh'}),/环境与实际/);
  const unknown=ledger.add({toolName:'powershell',input:{command:'not executed'},content:[{type:'text',text:'启动失败'}]});
  assert.equal(unknown.command,null);
  const native=ledger.add({toolName:'bash',input:{command:'echo amber'},content:[{type:'text',text:'amber'}],structuredContent:{exit_code:0}});
  assert.equal(native.command,'echo amber');
});

test('pwsh用户意图贯穿工具发现续轮；发现文档、历史任务不决定Shell',()=>{
  const messages=[{role:'user',content:'旧任务 bash'},{role:'assistant',content:[{type:'toolCall',name:'bash',arguments:{command:'echo old'}}]},{role:'user',content:'请用 pwsh 执行'},
    {role:'toolResult',content:[{type:'text',text:'run_shell supports Windows PowerShell 5.1, pwsh, bash'}]}];
  assert.equal(workEnvironmentHint('请用 pwsh 执行',messages),'powershell-core');
  assert.equal(workEnvironmentHint('请执行',messages),null);
  messages.push({role:'assistant',content:[{type:'toolCall',name:'mcp_call',arguments:{name:'run_shell',arguments:{shell:'windows-powershell',command:'echo now'}}}]});
  assert.equal(workEnvironmentHint('请执行',messages),'powershell-legacy');
  assert.equal(workEnvironmentHint('请用 pwsh 执行',messages),'powershell-core');
  assert.equal(applicableWork({environment:'PowerShell 5.1'},'powershell-core'),false);
  const continued=[{role:'user',content:'pwsh执行'}, {role:'toolResult',toolName:'mcp_call',content:[{type:'text',text:JSON.stringify({exitCode:0,shell:'pwsh'})}]},{role:'user',content:'继续'}];
  assert.equal(workEnvironmentHint('继续',continued),'powershell-core');
  assert.equal(workEnvironmentHint('做个新任务',continued),null);
  assert.equal(applicableWork({evidenceRefs:[{shell:'bash'},{shell:'pwsh'}]},'bash'),false);
});

test('本地和模型扩展均遵守环境限制；每次system刷新连目录也排除不适用经验',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-work-boundaries-'));
  try{
    await mkdir(join(root,'sessions'));const memory=new MemoryStore(root,join(root,'sessions'));
    await memory.rememberWork({kind:'shell',title:'PowerShell 5.1 分号',body:'amber violet legacy',environment:'PowerShell 5.1'},'test');
    await memory.rememberWork({kind:'shell',title:'PowerShell 7 分号',body:'amber violet core',environment:'PowerShell 7'},'test');
    memory.recallWork=createWorkRecaller({memory,model:()=>({provider:'test',id:'model'}),runtime:async()=>({completeSimple:async()=>({stopReason:'stop',content:[{type:'text',text:'{"query":"PowerShell 分号"}'}]})})});
    assert.equal(memory.workMatches('PowerShell',root,'powershell-core').length,1);
    const expanded=await memory.recallWork('执行一个无匹配词汇的任务',root,{environment:'powershell-core'});
    assert.equal(expanded.basis,'expanded');assert.deepEqual(expanded.items.map(i=>i.environment),['PowerShell 7']);
    const hooks={};roleFeatureExtension({memory,project:()=>root,roles:{current:()=>({})},goals:{section:async()=>null},learner:{},currentSession:()=>({sessionId:'test',state:{messages:[]}})})({on:(n,f)=>hooks[n]=f});
    const messages=[{role:'system'},{role:'user',content:'请用 pwsh 执行 PowerShell 分号任务'}];
    for(const suffix of [[],[{role:'toolResult',content:[{type:'text',text:'supports Windows PowerShell 5.1 and pwsh'}]}]]){
      const result=await hooks.context_with_system({messages:[...messages,...suffix]});
      const section=result.messages.at(-1).sections.summon_work;
      assert.match(section,/PowerShell 7/);assert.doesNotMatch(section,/PowerShell 5.1/);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('成功命令与证据元数据重启可恢复，纠正不会继承旧验证',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-evidence-restart-'));
  try{
    await mkdir(join(root,'sessions'));const memory=new MemoryStore(root,join(root,'sessions'));
    const ledger=new WorkEvidenceLedger(),record=ledger.add(output("Write-Output 'amber'"));
    const receipt=await memory.rememberWork(ledger.prepare({kind:'shell',title:'PowerShell 输出',body:'输出amber',evidenceIds:[record.id]}),'test');
    const restored=new MemoryStore(root,join(root,'sessions'));await restored.load();
    assert.deepEqual(restored.workItems()[0].validatedCommands,[record.command]);assert.equal(restored.workItems()[0].evidenceRefs[0].id,record.id);
    await restored.rememberWork({kind:'shell',title:'PowerShell 输出',body:'更正方法',operation:'replace',targetId:receipt.id},'test');
    assert.deepEqual(restored.workItems()[0].validatedCommands,[]);assert.equal(restored.workItems()[0].verificationScope,'legacy-unverified');
  }finally{await rm(root,{recursive:true,force:true});}
});
