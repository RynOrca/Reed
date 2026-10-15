import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LearnerStore} from './learner.mjs';

test('真实 bridge：模型每轮直接 recall_memory，无 read 仍读到队列且遵守画像关闭', {timeout:20000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-review-flow-')),data=join(root,'data');
  const requests=[],seen=[],waiters=new Set();let child,seq=0;
  const server=createServer(async(req,res)=>{
    let input='';for await(const part of req)input+=part;
    const body=JSON.parse(input);requests.push(body);
    const toolId=`review-${Math.ceil(requests.length/2)}`;
    const delta=requests.length%2?{role:'assistant',tool_calls:[{index:0,id:toolId,type:'function',function:{name:'recall_memory',arguments:JSON.stringify({area:'review',query:'今天有什么要复习'})}}]}:{role:'assistant',content:'复习清单已查询。'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const item of [{delta,finish_reason:null},{delta:{},finish_reason:requests.length%2?'tool_calls':'stop'}])res.write(`data: ${JSON.stringify({id:'mock-review',choices:[{index:0,...item}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const until=predicate=>{const found=seen.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('missing review event'));},6000);waiters.add(waiter);});};
  const command=async(type,args={})=>{const id=`review-command-${++seq}`;child.stdin.write(JSON.stringify({id,type,...args})+'\n');const event=await until(e=>e.id===id&&['ack','error','done'].includes(e.type));assert.notEqual(event.type,'error',event.message);return event;};
  try {
    await mkdir(data);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const learner=new LearnerStore(data);await learner.record({kind:'concept',subject:'REVIEW_QUEUE_SENTINEL 矩阵',detail:'已学习矩阵',evidence:'我学过矩阵'},'synthetic',['我学过矩阵']);
    const provider={id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',contextWindow:65536,maxTokens:2048,reasoning:false}]};
    await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},roles:{activeId:'agent',roles:[{id:'agent',name:'Agent',system:'隔离复习测试',learnerProfileEnabled:true,skills:[{skillId:'builtin-spaced-review',required:false}]}]},memoryEnabled:{l1:true,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
    await writeFile(join(data,'app-state.json'),JSON.stringify({provider:'synthetic',modelId:'mock',projectPath:root}));
    child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.resume();
    createInterface({input:child.stdout}).on('line',line=>{const event=JSON.parse(line);seen.push(event);for(const waiter of [...waiters])if(waiter.predicate(event)){clearTimeout(waiter.timer);waiters.delete(waiter);waiter.resolve(event);}});
    await until(e=>e.type==='ready');await command('init');
    for(let turn=1;turn<=2;turn++){
      await command('prompt',{text:'我有什么要复习的吗'});
      const [first,second]=requests.slice((turn-1)*2,turn*2);
      assert.match(JSON.stringify(first.messages.filter(m=>['system','developer'].includes(m.role))),/不需要重复 read/);
      const result=second.messages.find(m=>m.role==='tool'&&m.tool_call_id===`review-${turn}`);
      assert.match(JSON.stringify(result),/REVIEW_QUEUE_SENTINEL/);
      assert.doesNotMatch(JSON.stringify(result),/先加载|请先/);
    }
    await command('save_role',{roleId:'agent',name:'Agent',system:'隔离复习测试',learnerProfileEnabled:false});
    await command('prompt',{text:'我有什么要复习的吗'});
    const denied=requests[5].messages.find(m=>m.role==='tool'&&m.tool_call_id==='review-3');
    assert.match(JSON.stringify(denied),/已关闭学习画像/);
    assert.doesNotMatch(JSON.stringify(denied),/REVIEW_QUEUE_SENTINEL/);
    assert.equal(requests.length,6,'三轮直接工具调用各自只需两次模拟请求');
    assert.equal(seen.some(e=>e.type==='tool_start'&&e.name==='read'),false);
  } finally {
    for(const waiter of waiters)clearTimeout(waiter.timer);
    if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
