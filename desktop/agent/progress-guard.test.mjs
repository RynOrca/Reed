import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProgressGuard} from './progress-guard.mjs';

function fixture(options={}){
  const handlers=new Map(),guard=createProgressGuard(options);
  guard.extension({on:(event,handler)=>handlers.set(event,handler)});guard.begin();
  let index=0;
  return {guard,handlers,async call(name,input={},text='same',isError=false){
    const event={toolName:name,input,toolCallId:`call-${++index}`};
    const blocked=await handlers.get('tool_call')(event);if(blocked)return blocked;
    return handlers.get('tool_result')({...event,isError,content:[{type:'text',text}]});
  }};
}
test('repeated unchanged reads are corrected, then stop without a time/token budget',async()=>{
  const f=fixture();assert.equal(await f.call('read',{path:'a',offset:10,limit:30}),undefined);
  for(let i=0;i<2;i++)assert.equal(await f.call('read',{path:'a',offset:10,limit:30}),undefined);
  assert.match(JSON.stringify(await f.call('read',{path:'a',offset:10,limit:30})),/没有获得新信息/);
  for(let i=0;i<3;i++)await f.call('read',{path:'a',offset:10,limit:30});
  assert.equal((await f.call('read',{path:'a',offset:10,limit:30})).terminate,true);
  assert.equal(f.guard.outcome({status:'complete'}).code,'task_no_progress');
});
test('new evidence and changed external results allow useful work',async()=>{
  const f=fixture();
  for(let i=0;i<200;i++)assert.equal(await f.call('grep',{path:'a',pattern:`term-${i}`},`result-${i}`),undefined);
  for(let i=0;i<20;i++)assert.equal(await f.call('read',{path:'a'},`revision-${i}`),undefined);
  assert.equal(f.guard.outcome({status:'complete'}).status,'complete');
});
test('explicit polling and status tools may return identical data',async()=>{
  const f=fixture();f.guard.begin('持续监控文件，等待内容变化');
  for(let i=0;i<40;i++)assert.equal(await f.call('read',{path:'a'}),undefined);
  f.guard.begin();
  for(let i=0;i<40;i++)assert.equal(await f.call('browser',{action:'status'}),undefined);
});
test('alternating the same searches cannot evade stagnation detection',async()=>{
  const f=fixture();
  for(let i=0;i<9;i++)await f.call('grep',{path:'a',pattern:i%2?'one':'two'});
  assert.equal(f.guard.outcome({}).status,'error');
});
test('a real file change resets stagnation but repeated no-op writes do not',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'reed-progress-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'test.txt');await writeFile(path,'before');
  const f=fixture({workspace:()=>dir});
  for(let i=0;i<3;i++)await f.call('read',{path},'before');
  const event={toolName:'edit',toolCallId:'edit',input:{path,oldText:'before',newText:'after'}};
  await f.handlers.get('tool_call')(event);await writeFile(path,'after');
  assert.equal(await f.handlers.get('tool_result')({...event,isError:false,content:[{type:'text',text:'ok'}]}),undefined);
  for(let i=0;i<6;i++)await f.call('write',{path,content:'after'},'ok');
  assert.equal(f.guard.outcome({}).code,'task_no_progress');
});
test('each user turn resets the guard and diagnostics retain no user content',async()=>{
  const records=[],f=fixture({diagnostic:event=>records.push(event)});
  for(let i=0;i<8;i++)await f.call('read',{path:'PRIVATE_PATH'},'PRIVATE_CONTENT');
  assert.ok(records.length);assert.ok(!JSON.stringify(records).includes('PRIVATE'));
  f.guard.end();f.guard.begin();assert.equal(await f.call('read',{path:'PRIVATE_PATH'}),undefined);
  assert.equal(f.guard.outcome({status:'complete'}).status,'complete');
});
