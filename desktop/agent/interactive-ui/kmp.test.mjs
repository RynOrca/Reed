import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createKmpTrace,KMP_CODE,validKmpInput} from '../../web/kmp-trace.mjs';
import {validateDocument,validateState,initialArtifactState} from './protocol.mjs';
import {createFixedDocument} from './fixtures.mjs';
import {InteractiveArtifactStore} from './artifacts.mjs';

test('完整 KMP 与展示源码的每次字符比较、回退和 pi 写入一致，独立穷举核对结果',()=>{
  const words=[''];for(let n=1;n<=4;n++)for(let bits=0;bits<2**n;bits++)words.push(Array.from({length:n},(_,i)=>(bits>>i)&1?'A':'B').join(''));
  const cases=words.flatMap(text=>words.map(pattern=>({text,pattern})));
  cases.push({text:'ABABABC',pattern:'ABABC'},{text:'你好你好世界',pattern:'你好世界'},{text:' '.repeat(48),pattern:' '.repeat(24)},{text:'A'.repeat(48),pattern:'A'.repeat(23)+'B'});
  const source=KMP_CODE.join('\n').replace('pattern[i] !== pattern[j]','!eq(pattern[i],pattern[j],5,i,j)').replace('pattern[i] === pattern[j]','eq(pattern[i],pattern[j],8,i,j)').replace('text[i] !== pattern[j]','!eq(text[i],pattern[j],14,i,j)').replace('text[i] === pattern[j]','eq(text[i],pattern[j],17,i,j)').replace('j = pi[j - 1];','j = pi[j - 1]; fallbacks.push([6,i,j]);').replace('j = pi[j - 1];\n    }','j = pi[j - 1]; fallbacks.push([15,i,j]);\n    }').replace('pi[i] = j;','pi[i] = j; writes.push([i,j]);');
  for(const input of cases){
    const comparisons=[],fallbacks=[],writes=[],trace=createKmpTrace(input);
    const result=runInNewContext(source+'\nkmp(text,pattern);',{...input,fallbacks,writes,eq:(a,b,line,i,j)=>{comparisons.push([line,i,j,a===b]);return a===b;}});
    assert.equal(result,input.text.indexOf(input.pattern));assert.equal(trace.at(-1).result,result);assert.equal(trace.at(-1).stack.length,0);
    assert.deepEqual(trace.filter(s=>s.comparison).map(s=>[s.line,s.comparison.left,s.comparison.right,s.comparison.equal]),comparisons);
    assert.deepEqual(trace.filter(s=>s.line===6||s.line===15).map(s=>[s.line,s.i,s.j]),fallbacks.map(row=>Array.from(row)));
    assert.deepEqual(trace.filter(s=>s.line===9).map(s=>[s.i,s.pi[s.i]]),writes.map(row=>Array.from(row)));
    const expected=Array.from({length:input.pattern.length},(_,i)=>{const part=input.pattern.slice(0,i+1);for(let n=i;n>0;n--)if(part.slice(0,n)===part.slice(-n))return n;return 0;});
    assert.deepEqual(trace.at(-1).pi,expected);assert.ok(trace.length<2000);
    for(const [index,step] of trace.entries()){
      if(step.line===6||step.line===15){assert.equal(step.i,trace[index-1].i);assert.ok(step.j<trace[index-1].j);}
      if(step.phase==='search'&&step.j>0)assert.equal(input.text.slice(step.offset,step.offset+step.j),input.pattern.slice(0,step.j));
      if(step.comparison)assert.equal(step.offset+step.comparison.right,step.comparison.left);
    }
  }
});

test('KMP 严格校验输入、历史状态与轨迹边界；恢复用户修改的字符串和步骤',async()=>{
  for(const input of [[],{}, {text:'a',pattern:'b',extra:1},{text:'a'.repeat(49),pattern:'a'},{text:'a',pattern:'b'.repeat(25)},{text:'😀',pattern:''},{text:'a\n',pattern:'a'}])assert.equal(validKmpInput(input),false);
  const document=createFixedDocument('kmp-full');validateDocument(document);assert.deepEqual(initialArtifactState(document),{step:0,input:document.input});
  assert.throws(()=>validateDocument({...document,input:[1,2]}),/无效/);assert.throws(()=>validateDocument({...document,code:'x'}),/无效/);
  const root=await mkdtemp(join(tmpdir(),'reed-kmp-'));try{
    const store=new InteractiveArtifactStore(root),session=randomUUID(),artifact=await store.create(session,document),state={step:12,input:{text:'AAAAAB',pattern:'AAAB'}};
    assert.ok(validateState(document,state));assert.equal(validateState(document,{...state,step:2000}),false);
    await store.saveState(session,artifact.artifactId,state);assert.deepEqual((await new InteractiveArtifactStore(root).read(session,artifact.artifactId)).state,state);
  }finally{await rm(root,{recursive:true,force:true});}
});
