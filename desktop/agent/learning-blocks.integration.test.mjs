import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {learningReplyText} from './learning-blocks.mjs';
import {ConversationCanvasStore} from './conversation-canvas.mjs';
import {visibleCanvasNodes} from '../web/canvas-geometry.js';

test('真实 bridge 学习块：正文顺序、回执持久化、重启恢复、来源校验及旧题失效',{timeout:45000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-learning-')),data=join(root,'data'),seen=[],waiters=new Set();let child,seq=0,calls=0;
  const question={id:'q',type:'choices',title:'非零整数的真值是什么？',fallbackText:'请选择真或不确定。',options:[{id:'yes',label:'真',replyText:'非零整数为真。'},{id:'unsure',label:'不确定',replyText:'我还不确定。'}]};
  const spec={schemaVersion:1,fallbackText:'gcd 返回整数，非零为真。',blocks:[{id:'flow',type:'flow',title:'条件判断过程',fallbackText:'输入 3，判断为真。',nodes:[{label:'输入',value:'3'},{label:'判断',value:'真'}]},question]};
  const fill={id:'fill',type:'fill',title:'补全加法',label:'c_sum =',fallbackText:'填入同态加法表达式。'};const fillSpec={schemaVersion:1,fallbackText:'填写 c_sum 的表达式。',blocks:[fill]};
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls++;
    const last=body.messages.at(-1);const tool=last?.role==='tool';const user=body.messages.findLast(m=>m.role==='user');
    const userText=typeof user?.content==='string'?user.content:(user?.content||[]).map(b=>b.text||'').join('');
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'synthetic',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`);
    if(!tool&&['解释非零条件','填空练习'].includes(userText)){
      assert.ok(body.tools.some(t=>t.function.name==='show_learning'));
      send({role:'assistant',content:'先看条件的输入与输出。'});
      send({tool_calls:[{index:0,id:userText==='填空练习'?'fill-call':'learning-call',type:'function',function:{name:'show_learning',arguments:JSON.stringify(userText==='填空练习'?fillSpec:spec)}}]});send({},'tool_calls');
    }else{send({role:'assistant',content:tool?'图解后继续解释：请尝试回答。':'回答已收到：非零整数为真。'});send({},'stop');}
    res.end('data: [DONE]\n\n');
  });
  const until=(predicate,from=0)=>{const existing=seen.slice(from).find(predicate);if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const waiter={predicate,resolve};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('学习块事件超时'));},12000);waiters.add(waiter);});};
  const command=async(type,args={})=>{const id='learning-'+ ++seq;child.stdin.write(JSON.stringify({id,type,...args})+'\n');const result=await until(e=>e.id===id&&['ack','error','done','conversation'].includes(e.type));if(result.type==='error')throw Error(result.message);return result;};
  const start=async()=>{
    const from=seen.length;child=spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.resume();
    createInterface({input:child.stdout}).on('line',line=>{const e=JSON.parse(line);seen.push(e);for(const w of [...waiters])if(w.predicate(e)){clearTimeout(w.timer);waiters.delete(w);w.resolve(e);}});
    await until(e=>e.type==='ready',from);await command('init');
  };
  const stop=async()=>{if(child?.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}};
  try{
    await mkdir(data);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const provider={id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',contextWindow:65536,maxTokens:4096,reasoning:false}]};
    await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[provider]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
    await writeFile(join(data,'app-state.json'),JSON.stringify({provider:'synthetic',modelId:'mock',projectPath:root}));
    await start();const sessionId=seen.findLast(e=>e.type==='session').sessionId;
    await command('prompt',{text:'解释非零条件'});
    const toolEvent=seen.find(e=>e.type==='tool_end'&&e.id==='learning-call');assert.deepEqual(toolEvent.result.details.learning,spec);
    const order=seen.filter(e=>e.type==='delta'||e.type==='tool_end');assert.ok(order.findIndex(e=>e.text?.includes('先看'))<order.indexOf(toolEvent));assert.ok(order.findIndex(e=>e.text?.includes('图解后'))>order.indexOf(toolEvent));
    const copied=await command('copy_session');assert.ok(seen.findLast(e=>e.type==='conversation').text.includes(spec.fallbackText));
    await stop();await start();const history=seen.findLast(e=>e.type==='history').messages;
    assert.deepEqual(history.find(m=>m.toolCallId==='learning-call').details.learning,spec);
    const reply={sessionId,toolCallId:'learning-call',blockId:'q',optionId:'yes'},text=learningReplyText(question,question.options[0]);const before=calls;
    await assert.rejects(command('prompt',{text,learningReply:{...reply,sessionId:'other'}}),/过期|会话/);
    await assert.rejects(command('prompt',{text:'被修改的回复',learningReply:reply}),/不一致/);assert.equal(calls,before);
    await command('prompt',{text,learningReply:reply});await assert.rejects(command('prompt',{text,learningReply:reply}),/过期/);
    await command('get_history');const restored=seen.findLast(e=>e.type==='history').messages;assert.equal(restored.filter(m=>m.role==='user'&&m.content.some(b=>b.text===text)).length,1);
    assert.equal(restored.find(m=>m.role==='user'&&m.learningReply)?.learningReply.optionId,'yes');
    await command('prompt',{text:'填空练习'});const fillReply={sessionId,toolCallId:'fill-call',blockId:'fill',answer:'(c1 * c2) % (n ** 2)'};
    await command('prompt',{text:learningReplyText(fill,fillReply.answer),learningReply:fillReply});
    await stop();await start();const finalHistory=seen.findLast(e=>e.type==='history').messages;
    const submitted=finalHistory.find(m=>m.learningReply?.toolCallId==='fill-call');assert.equal(submitted.learningReply.answer,fillReply.answer);assert.ok(submitted.learningReply.parentUserId);
    const entries=finalHistory.map(m=>({type:'message',id:m.messageId,message:{...m,reedLearningReply:m.learningReply}}));
    const canvas=new ConversationCanvasStore(data);const graph=await canvas.sync(sessionId,entries);assert.equal(graph.edges.filter(e=>e.kind==='learning_reply').length,2);
    const edge=graph.edges.find(e=>e.to===submitted.messageId);assert.equal(edge.from,submitted.learningReply.parentUserId);assert.equal(edge.type,'作答');
    await canvas.edit(sessionId,{nodes:[{id:edge.from,answersCollapsed:true}]});const collapsed=await new ConversationCanvasStore(data).get(sessionId);assert.equal(collapsed.nodes.length,graph.nodes.length);assert.equal(visibleCanvasNodes(collapsed).some(n=>n.id===edge.to),false);

  }finally{for(const w of waiters)clearTimeout(w.timer);await stop();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
