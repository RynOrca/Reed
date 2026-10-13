import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createQuicksortTrace, QUICKSORT_CODE } from '../../web/quicksort-trace.mjs';
import { validateDocument, validateState } from './protocol.mjs';
import { InteractiveArtifactStore } from './artifacts.mjs';
import { createFixedDocument } from './fixtures.mjs';

test('完整快排轨迹与展示代码实际执行的每次交换和比较一致，覆盖全部递归与边界', () => {
  const cases=[[],[1],[1,1],[7,3,9,2,5],[-5,0,2,-5],Array.from({length:12},(_,i)=>i),Array.from({length:12},(_,i)=>12-i),Array(12).fill(2)];
  let seed=42;
  for(let n=0;n<40;n++) cases.push(Array.from({length:n%13},()=>{seed=(seed*1664525+1013904223)>>>0;return seed%15-7;}));
  for(const input of cases){
    const trace=createQuicksortTrace(input), a=[...input], seen=[], compared=[];
    const code=QUICKSORT_CODE.map((line,index)=>line + ([12,16].includes(index+1)?' seen.push([...a]);':'') + (index+1===10?' compared.push([j,a[j],pivot]);':'')).join('\n');
    runInNewContext(code+'\nquicksort(a);',{a,seen,compared});
    assert.deepEqual(trace.at(-1).array,[...input].sort((a,b)=>a-b));
    assert.deepEqual(a,trace.at(-1).array);
    assert.deepEqual(trace.filter(s=>s.line===12||s.line===16).map(s=>s.array),seen.map(row=>Array.from(row)));
    assert.deepEqual(trace.filter(s=>s.line===11).map(s=>[s.variables.j,s.array[s.variables.j],s.variables.pivot]),compared.map(row=>Array.from(row)));
    assert.deepEqual(input,trace[0].array);
    assert.equal(trace.at(-1).stack.length,0);
    assert.equal(trace.at(-1).comparisons,compared.length);
    assert.ok(trace.length<2000);
    for(const snapshot of trace){
      assert.ok(snapshot.line>=1&&snapshot.line<=QUICKSORT_CODE.length);
      assert.deepEqual([...snapshot.array].sort((a,b)=>a-b),a);
      for(const index of snapshot.fixed)assert.equal(snapshot.array[index],a[index]);
    }
  }
  assert.throws(()=>createQuicksortTrace(Array(13).fill(1)),/0–12/);
  assert.throws(()=>createQuicksortTrace([NaN]),/0–12/);
});

test('算法作品只接受已知版本，输入与步骤保存恢复，越界状态拒绝', async () => {
  const root=await mkdtemp(join(tmpdir(),'reed-sort-artifact-'));
  try {
    const document=createFixedDocument('quicksort-full');validateDocument(document);
    assert.throws(()=>validateDocument({...document,code:'alert(1)'}),/无效/);
    assert.throws(()=>validateDocument({...document,algorithm:'custom'}),/无效/);
    assert.throws(()=>validateDocument({...document,input:Array(13).fill(1)}),/无效/);
    const input=[3,3,-1,0],step=createQuicksortTrace(input).length-1;
    assert.ok(validateState(document,{input,step}));
    assert.ok(!validateState(document,{input,step:step+1}));
    assert.ok(!validateState(document,{input,step,code:'evil'}));
    const store=new InteractiveArtifactStore(root),sessionId=randomUUID();
    const artifact=await store.create(sessionId,document);
    assert.deepEqual(artifact.state,{step:0,input:document.input});
    await store.saveState(sessionId,artifact.artifactId,{input,step});
    const restored=await new InteractiveArtifactStore(root).read(sessionId,artifact.artifactId);
    assert.deepEqual(restored.state,{input,step});
    assert.deepEqual(createQuicksortTrace(restored.state.input)[restored.state.step].array,[-1,0,3,3]);
  } finally {await rm(root,{recursive:true,force:true});}
});
