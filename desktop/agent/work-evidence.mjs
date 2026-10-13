import {createHash,randomUUID} from 'node:crypto';
import {shellEnvironment} from './work-applicability.mjs';

const normalize=s=>String(s).replace(/\r\n/g,'\n').trim();
function strings(value,depth=0){
  if(depth>5||value==null)return [];
  if(typeof value==='string'){let nested=[];try{nested=strings(JSON.parse(value),depth+1);}catch{}return [value,...nested].filter(s=>s.length>=4).map(s=>s.slice(0,6000));}
  if(Array.isArray(value))return value.flatMap(v=>strings(v,depth+1));
  if(typeof value==='object')return Object.values(value).flatMap(v=>strings(v,depth+1));
  return [];
}
function outputs(content){
  const objects=[];
  for(const block of content||[]){if(block.type!=='text')continue;try{const value=JSON.parse(block.text);if(value&&typeof value==='object')objects.push(value);}catch{}}
  return objects;
}
export class WorkEvidenceLedger{
  constructor(){this.records=[];this.sequence=0;this.nonce=randomUUID();}
  add(event){
    const input=event.input||{},objects=[...outputs(event.content),event.structuredContent].filter(Boolean);
    const command=input.command??input.arguments?.command;
    const result=objects.find(o=>Number.isInteger(o.exitCode)||Number.isInteger(o.exit_code));
    const exitCode=result?.exitCode??result?.exit_code??event.details?.exitCode;
    const ok=!event.isError&&(exitCode===undefined||exitCode===0);
    const verified=ok&&typeof command==='string'&&exitCode===0;
    const executionKey=JSON.stringify([event.toolName,input.serverId||input.server||'',input.name||input.toolName||'']);
    const record={id:'ev-'+createHash('sha256').update(this.nonce+String(event.toolCallId||++this.sequence)).digest('hex').slice(0,16),executionKey,tool:event.toolName,ok,quotes:strings(event.toolName==='read'?input:[input,event.content]).slice(-20),text:JSON.stringify({tool:event.toolName,input,result:event.toolName==='read'?undefined:event.content,isError:event.isError}).slice(0,6000),command:verified?command:null,shell:typeof result?.shell==='string'?result.shell:input.arguments?.shell||input.shell||(event.toolName==='bash'?'bash':null)};
    this.records.push(record);this.records=this.records.slice(-12);return record;
  }
  references(input){
    if(input.evidenceIds?.length){const refs=input.evidenceIds.map(id=>this.records.find(r=>r.id===id));if(refs.some(r=>!r))throw Error('证据ID不属于本轮真实工具结果，请重新引用本轮收据');return [...new Set(refs)];}
    if(typeof input.evidence!=='string'||input.evidence.length<4)return [];
    return this.records.filter(r=>r.quotes.some(q=>q.includes(input.evidence))||r.text.includes(input.evidence)||r.text.includes(JSON.stringify(input.evidence).slice(1,-1)));
  }
  prepare(input){
    const refs=this.references(input);if(!refs.length)throw Error('请提供本轮证据ID，或逐字引用一段工具原文，不能拼接说明');
    let commands=[];
    if(input.kind==='shell'){
      const verified=refs.filter(r=>r.command&&r.ok);
      const proposed=input.validatedCommands?.length?input.validatedCommands:verified.map(r=>r.command);
      if(!proposed.length||proposed.some(command=>!verified.some(r=>normalize(r.command)===normalize(command))))throw Error('Shell方法必须包含本轮成功执行的命令；不能把未执行步骤作为已验证方法');
      commands=[...new Set(proposed.map(normalize))];
      if(commands.join('\n').length>700)throw Error('已验证命令超过经验步骤长度上限，请只选择需要复用的短命令，不截断命令');
      const advice=[input.body,input.steps].join('\n');
      const conditional=/\bif\s*\(|\bif\s+|\belse\b|\$LASTEXITCODE|条件执行|仅在.*成功|只在.*成功/i;
      if(conditional.test(advice)&&!commands.some(command=>conditional.test(command)))throw Error('候选含未经执行验证的条件分支。请删除该分支，仅保存收据中的成功命令，或先实际验证分支');
      const observed=[...new Set(verified.filter(r=>commands.includes(normalize(r.command))).map(r=>shellEnvironment(r.shell)).filter(Boolean))];
      if(observed.length>1)throw Error('多个Shell环境的成功命令必须拆成不同经验，不能合为一种方法');
      const claimed=shellEnvironment(input.environment);
      if(claimed&&claimed!=='powershell-unknown'&&observed.length&&observed.some(s=>s!==claimed))throw Error('声明的Shell环境与实际执行收据不符，不能跨环境归纳');
      if(observed.length)input={...input,environment:observed.join(',')};
    }
    const successful=refs.filter(r=>r.ok);
    if(!successful.length)throw Error('缺少与本方法对应的成功验证，请引用成功结果收据');
    const exact=typeof input.evidence==='string'&&refs.some(r=>r.quotes.some(q=>q.includes(input.evidence))||r.text.includes(input.evidence));
    const evidence=exact?input.evidence:successful.at(-1)?.quotes.findLast(q=>q.length>=4&&q.length<=500)||refs[0].quotes.findLast(q=>q.length>=4&&q.length<=500)||refs[0].id;
    return {...input,evidence,validatedCommands:commands,evidenceRefs:refs.map(({id,tool,ok,command,shell})=>({id,tool,ok,command,shell})),verificationScope:commands.length?'observed-command':'observed-tool-result',...(commands.length?{steps:commands.join('\n')}:{})};
  }
  hint(){const safe=s=>!s||!/api[_ -]?key|password|authorization|bearer\s|secret/i.test(s);return this.records.filter(r=>r.ok&&safe(r.command)).slice(-2).map(r=>({id:r.id,tool:r.tool,verifiedCommand:r.command,quotes:r.quotes.filter(q=>q.length<=300&&safe(q)).slice(-2)}));}
}

export function experienceIdentity(input){return [input.targetId||'',input.kind||'',String(input.title||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'')].join('|');}
