import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
export function syntheticPdf(){
  const bodies=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',null,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for(const [i,text]of [[3,'PAGE_ONE_MARKER Alpha formula'],[5,'PAGE_TWO_FUTURE Hidden later page']]){const stream=`BT /F1 16 Tf 40 420 Td (${text}) Tj ET`;bodies[i]=`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;}
  let result='%PDF-1.4\n',offsets=[0];for(let i=0;i<bodies.length;i++){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${bodies[i]}\nendobj\n`;}
  const start=Buffer.byteLength(result);result+=`xref\n0 8\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(result);
}
const text=message=>typeof message?.content==='string'?message.content:(message?.content||[]).map(b=>b.text||'').join('\n');
export async function materialsHarness(){
  const root=await mkdtemp(join(tmpdir(),'reed-test-materials-flow-')),data=join(root,'data'),events=[],requests=[],waiters=new Set();let seq=0,stderr='',held=null;
  await mkdir(data);const pdf=join(root,'test-book.pdf');await writeFile(pdf,syntheticPdf());
  const api=createServer(async(req,res)=>{
    try{if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock',context_length:65536}]}));return;}
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);const last=text(body.messages.findLast(m=>m.role==='user')),system=body.messages.filter(m=>['system','developer'].includes(m.role)).map(text).join('\n');let answer='SYNTHETIC_REPLY';
      if(system.includes('你是出卷教师')){
        if(held){const gate=held;held=null;gate.started();await gate.releasePromise;}
        const refs=JSON.parse(last.split('参考页ID：').at(-1)),count=Number(/生成 (\d+) 题/.exec(last)[1]);
        answer=JSON.stringify({questions:Array.from({length:count},(_,i)=>({type:'choice',prompt:`测试题 ${i+1}：1+1 等于多少？`,options:[{id:'A',text:'2'},{id:'B',text:'3'}],answer:'A',explanation:'PRIVATE_TEACHER_EXPLANATION',topic:'加法',difficulty:'easy',references:[refs[0]]}))});
      }else if(system.includes('你是阅卷教师'))answer=JSON.stringify({grades:JSON.parse(last).map(q=>({id:q.id,score:7,feedback:'SYNTHETIC_GRADE'}))});
      else if(last==='MATH_RENDER_TEST')answer='字段 $raw_content$ 和 $followup_questions$ 应保持代码格式。\n\n真正的公式：$x_i + y^2 = \\lambda$。';
      const paperTool=!system.includes('你是出卷教师')&&last.startsWith('PAPER_TOOL_TEST')&&body.messages.at(-1).role!=='tool';
      const delta=paperTool?{role:'assistant',tool_calls:[{index:0,id:'test-paper-tool',type:'function',function:{name:'create_practice_paper',arguments:JSON.stringify({count:1,topic:'',type:'choice'})}}]}:{role:'assistant',content:answer};
      res.writeHead(200,{'content-type':'text/event-stream'});for(const [part,finish_reason]of [[delta,null],[{},paperTool?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'mock',model:'mock',choices:[{index:0,delta:part,finish_reason}]})}\n\n`);res.end('data: [DONE]\n\n');
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:String(error.message)}}));}
  });await new Promise(r=>api.listen(0,'127.0.0.1',r));
  await writeFile(join(data,'user-config.json'),JSON.stringify({version:1,providers:{providers:[{id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${api.address().port}/v1`,protocol:'openai-completions',models:[{id:'mock',contextWindow:65536,maxTokens:8192,reasoning:false}]}]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:null,skills:[],webEnabled:false,browserEnabled:false}}));
  await writeFile(join(data,'app-state.json'),JSON.stringify({provider:'synthetic',modelId:'mock',projectPath:root}));
  const child=spawn(process.execPath,[resolve('desktop/agent/bridge.mjs')],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});child.stderr.on('data',b=>stderr+=b);
  createInterface({input:child.stdout}).on('line',line=>{const event=JSON.parse(line);events.push(event);for(const waiter of [...waiters])if(waiter.predicate(event)){clearTimeout(waiter.timer);waiters.delete(waiter);waiter.resolve(event);}});
  const until=(predicate,from=0)=>{const value=events.slice(from).find(predicate);if(value)return Promise.resolve(value);return new Promise((resolve,reject)=>{const waiter={predicate,resolve};waiter.timer=setTimeout(()=>{waiters.delete(waiter);reject(Error('隔离测试事件超时：'+stderr.slice(-1000)));},20000);waiters.add(waiter);});};
  const call=async(type,args={})=>{const id='materials-test-'+ ++seq;child.stdin.write(JSON.stringify({id,type,...args})+'\n');const event=await until(e=>e.id===id&&['ack','error','done','conversation'].includes(e.type));if(event.type==='error')throw Error(event.message);return event;};
  await until(e=>e.type==='ready');await call('init');const sessionId=events.findLast(e=>e.type==='session').sessionId;
  return {root,data,pdf,events,requests,sessionId,until,call,material:async(type,args={})=>(await call(type,{sessionId,...args})).material,
    async side(text,readingContext){const id='materials-side-'+ ++seq;child.stdin.write(JSON.stringify({type:'side_chat_prompt',id,text,readingContext})+'\n');const event=await until(e=>e.type==='side_chat_event'&&e.id===id&&['done','error'].includes(e.state));if(event.state==='error')throw Error(event.message);return event;},
    holdGeneration(){let start,release;const started=new Promise(r=>start=r),releasePromise=new Promise(r=>release=r);held={started:start,releasePromise};return {started,release};},
    async close(){for(const waiter of waiters)clearTimeout(waiter.timer);if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}api.closeAllConnections();await new Promise(r=>api.close(r));await rm(root,{recursive:true,force:true,maxRetries:5});}
  };
}
