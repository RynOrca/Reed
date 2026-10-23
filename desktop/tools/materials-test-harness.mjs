import {deflateRawSync} from 'node:zlib';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
export function syntheticPdf({pages=2,scanPage=0,outline=false}={}){
  const font=3+pages*2,bodies=[`<< /Type /Catalog /Pages 2 0 R ${outline?'/Outlines '+(font+1)+' 0 R':''} >>`,`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${3+i*2} 0 R`).join(' ')}] /Count ${pages} >>`];
  for(let i=0;i<pages;i++){
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4+i*2} 0 R >>`);
    const marker=i===0?'PAGE_ONE_MARKER Alpha formula':i===1?'PAGE_TWO_FUTURE Hidden later page':`PAGE_${i+1}_MARKER`;
    // An actual image-only page: no text operators or hidden text layer.
    const pixels=Array.from({length:64},(_,pixel)=>pixel%2?'183c28':'d7b568').join('');
    const stream=i+1===scanPage?`q 300 0 0 380 50 60 cm BI /W 8 /H 8 /CS /RGB /BPC 8 /F /AHx ID\n${pixels}>\nEI Q`:`BT /F1 16 Tf 40 420 Td (${marker}) Tj ET\n`+Array.from({length:30},(_,row)=>`BT /F1 9 Tf 40 ${400-row*11} Td (Synthetic textbook line ${row+1}, page ${i+1}) Tj ET`).join('\n');
    bodies.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if(outline)bodies.push(`<< /Type /Outlines /First ${font+2} 0 R /Last ${font+2} 0 R /Count 1 >>`,`<< /Title (Native chapter) /Parent ${font+1} 0 R /Dest [3 0 R /Fit] >>`);
  let result='%PDF-1.4\n',offsets=[0];for(let i=0;i<bodies.length;i++){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${bodies[i]}\nendobj\n`;}
  const start=Buffer.byteLength(result),size=bodies.length+1;result+=`xref\n0 ${size}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(result);
}
const text=message=>typeof message?.content==='string'?message.content:(message?.content||[]).map(b=>b.text||'').join('\n');
export async function materialsHarness({pdfOptions}={}){
  const root=await mkdtemp(join(tmpdir(),'reed-test-materials-flow-')),data=join(root,'data'),events=[],requests=[],waiters=new Set();let seq=0,stderr='',held=null;
  await mkdir(data);const pdf=join(root,'test-book.pdf');await writeFile(pdf,syntheticPdf(pdfOptions));
  const api=createServer(async(req,res)=>{
    try{if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock',context_length:65536}]}));return;}
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);const last=text(body.messages.findLast(m=>m.role==='user')),system=body.messages.filter(m=>['system','developer'].includes(m.role)).map(text).join('\n');let answer='SYNTHETIC_REPLY';
      if(system.includes('资料大纲整理器')){const packet=JSON.parse(last);answer=JSON.stringify({items:packet.pages.filter(p=>p.text.trim()).map((p,i)=>({title:'测试章节 '+(p.pageIndex+1),pageIndex:p.pageIndex,level:i%3===0?0:1}))});}
      else if(system.includes('你是出卷教师')){
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

export function syntheticPptx({titles=true}={}){
 const files=new Map([['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],['ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>'+[1,2,3].map(i=>`<p:sldId id="${255+i}" r:id="s${i}"/>`).join('')+'</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>'],['ppt/_rels/presentation.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+[1,2,3].map(i=>`<Relationship Id="s${i}" Type="slide" Target="slides/slide${i}.xml"/>`).join('')+'</Relationships>']]);
 for(let i=1;i<=3;i++)files.set(`ppt/slides/slide${i}.xml`,`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/><p:cNvSpPr/><p:nvPr>${titles?'<p:ph type="title"/>':''}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="8000000" cy="1200000"/></a:xfrm><a:solidFill><a:srgbClr val="dceada"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>PPTX标题 ${i} 合成教材</a:t></a:r></a:p><a:p><a:r><a:rPr sz="1600"/><a:t>SLIDE_${i}_MARKER 概念与原理示例</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
 const locals=[],directory=[];let offset=0;
 const crc=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 for(const [name,text] of files){const n=Buffer.from(name),body=Buffer.from(text),packed=deflateRawSync(body),check=crc(body),local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(check,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(n.length,26);locals.push(local,n,packed);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(check,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);directory.push(central,n);offset+=local.length+n.length+packed.length;}
 const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,central,end]);
}
