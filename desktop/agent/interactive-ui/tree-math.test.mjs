import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createHeapsortTrace,HEAPSORT_CODE} from '../../web/heapsort-trace.mjs';
import {quadraticValues,linearValues,validMathState} from '../../web/math-models.mjs';
import {validateDocument,validateState} from './protocol.mjs';
import {createFixedDocument} from './fixtures.mjs';
import {InteractiveArtifactStore} from './artifacts.mjs';

test('堆排序每次交换与展示源码一致，建堆/有效堆不变量和最终位置独立核对',()=>{
  const cases=[[],[1],[2,1],[4,10,3,5,1],[3,-1,3,0],Array(12).fill(1),Array.from({length:12},(_,i)=>i),Array.from({length:12},(_,i)=>12-i)];
  let seed=17;for(let n=0;n<40;n++)cases.push(Array.from({length:n%13},()=>{seed=(seed*1664525+1013904223)>>>0;return seed%17-8;}));
  for(const input of cases){
    const a=[...input],seen=[],trace=createHeapsortTrace(input);
    const source=HEAPSORT_CODE.map((line,index)=>line+([5,14].includes(index+1)?' seen.push([...a]);':'')).join('\n');
    runInNewContext(source+'\nheapSort(a);',{a,seen});
    assert.deepEqual(a,[...input].sort((a,b)=>a-b));
    assert.deepEqual(trace.at(-1).array,a);
    assert.deepEqual(trace.filter(s=>s.line===5||s.line===14).map(s=>s.array),seen.map(row=>Array.from(row)));
    assert.equal(trace.at(-1).stack.length,0);assert.equal(trace.at(-1).heapSize,0);assert.ok(trace.length<2000);
    for(const step of trace){
      assert.deepEqual([...step.array].sort((a,b)=>a-b),a);
      for(const i of step.fixed)assert.equal(step.array[i],a[i]);
      assert.ok(step.heapSize>=0&&step.heapSize<=input.length);
      if(step.action==='建堆完成'||step.line===4){for(let i=1;i<step.heapSize;i++)assert.ok(step.array[Math.floor((i-1)/2)]>=step.array[i]);}
    }
  }
});

test('函数值、切线斜率、矩阵乘法与面积独立核算，覆盖退化、反向和插值奇异',()=>{
  for(const a of [-3,-1,0,.5,3])for(const x of [-5,-1,0,2,5]){
    const state={a,h:1,k:-2,x},q=quadraticValues(state),epsilon=1e-5;
    assert.equal(q.y,a*(x-1)*(x-1)-2);
    assert.ok(Math.abs(q.slope-(q.at(x+epsilon)-q.at(x-epsilon))/(2*epsilon))<1e-6);
  }
  for(const matrix of [[1,1,0,1],[0,-1,1,0],[2,0,0,3],[-1,0,0,1],[1,2,2,4],[-1,0,0,-1]])for(const t of [0,.5,1]){
    const [a,b,c,d]=matrix,state={a,b,c,d,vx:2,vy:-1,t},result=linearValues(state);
    assert.deepEqual(result.targetVector,[2*a-b,2*c-d]);
    const [u,v]=[result.transform(1,0),result.transform(0,1)];
    assert.equal(result.currentDeterminant,u[0]*v[1]-u[1]*v[0]);
    assert.deepEqual(result.vector,[u[0]*2-v[0],u[1]*2-v[1]]);
    assert.equal(result.determinant,a*d-b*c);
    if(t===0)assert.deepEqual(result.vector,[2,-1]);
    if(t===1)assert.deepEqual(result.vector,result.targetVector);
  }
  assert.equal(linearValues({a:-1,b:0,c:0,d:-1,vx:1,vy:1,t:.5}).currentDeterminant,0);
  assert.ok(!validMathState('__proto__',{}));
  assert.ok(!validMathState('quadratic-v1',{a:NaN,h:0,k:0,x:0}));
});

test('三类新作品严格校验并保存用户状态，重开恢复；非法参数与代码拒绝',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-tree-math-'));
  try{
    const store=new InteractiveArtifactStore(root),sessionId=randomUUID();
    for(const topic of ['heapsort','quadratic','linear-transform']){
      const doc=createFixedDocument(topic);assert.equal(validateDocument(doc),doc);
      assert.throws(()=>validateDocument({...doc,code:'alert(1)'}),/无效/);
      const artifact=await store.create(sessionId,doc);
      const state=topic==='heapsort'?{input:[3,-1,3,0],step:12}:topic==='quadratic'?{a:0,h:2,k:1,x:-1}:{a:1,b:2,c:1,d:2,vx:2,vy:1,t:.5};
      assert.ok(validateState(doc,state));await store.saveState(sessionId,artifact.artifactId,state);
      assert.deepEqual((await new InteractiveArtifactStore(root).read(sessionId,artifact.artifactId)).state,state);
      assert.ok(!validateState(doc,{...state,extra:1}));
      if(topic!=='heapsort')assert.ok(!validateState(doc,{...state,a:100}));
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
