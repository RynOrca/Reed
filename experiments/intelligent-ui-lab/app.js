const $ = id => document.getElementById(id);
const configFields = ['base','model','protocol','effort','maxTokens'];
let records = [], active = -1, busy = false;
try { const saved = JSON.parse(localStorage.getItem('reed-ui-lab-config') || '{}'); for (const id of configFields) if (saved[id] !== undefined) $(id).value = saved[id]; } catch {}
const examples = {
  kmp: '用可交互页面解释 KMP。文本串 ABABABCABABABC，模式串 ABABAC。分别提供前缀函数 π 的构建与匹配演示，采用 0 基下标，明确 π 的定义。支持上一步、下一步、重置，标出比较位置、相等的前后缀与失配跳转依据，并显示对应伪代码。',
  sort: '用单步交互演示快速排序，输入 [6,3,8,2,7,1,5,4]。明确使用 Lomuto 分区、末元素为 pivot。展示扫描指针、分区边界、交换、递归区间和伪代码行。可修改输入、上一步、下一步、重置。',
  attention: '用一个可以操作的小型数值例子解释 scaled dot-product attention。显示 Q、K、V、QK转置、缩放、softmax、输出的维度及具体数值。可修改一个数值并重算，支持因果掩码开关，清楚标注这是示例而非真实大模型内部数据。',
  rl: '用一个小型确定性网格世界交互解释 Bellman 最优更新。终点固定，明确奖励、终止状态与同步更新约定，可调 gamma，单步进行一轮价值迭代，展示选中格子的每个动作、候选价值及最终 max。提供上一步和重置。'
};
document.querySelectorAll('[data-example]').forEach(button => button.onclick = () => { $('prompt').value = examples[button.dataset.example]; });
function status(text, error=false) { $('status').textContent=text; $('status').classList.toggle('error',error); }
function controls() { $('generate').disabled=busy; $('testConnection').disabled=busy; $('revise').disabled=busy||active<0; $('apply').disabled=busy||active<0; $('download').disabled=active<0; $('export').disabled=!records.length; }
function protocolHint() { const p=$('protocol').value; $('effort').disabled=p==='none'; $('protocolHint').textContent=p==='none'?'不发送思考参数，使用服务默认行为。':p==='reasoning_effort'?'按所选档位发送；关闭发送 none。接口不支持的档位会报错。':p==='deepseek'?'发送 thinking 开关和 reasoning_effort。minimal/low → low；medium/high/xhigh → high；max → max。':'Qwen 此格式只支持开启 / 关闭。除“关闭”外，其余档位均发送开启，不代表实际推理强度。'; }
$('protocol').onchange=protocolHint; protocolHint();
$('saveConfig').onclick=()=>{try { localStorage.setItem('reed-ui-lab-config',JSON.stringify(Object.fromEntries(configFields.map(id=>[id,$(id).value])))); status('连接配置已保存，API Key 未保存。'); } catch { status('浏览器不允许保存配置。',true); } };
function extract(raw) { const fenced=raw.match(/```(?:html)?\s*\n([\s\S]*?)```/i); const text=(fenced?fenced[1]:raw).trim(); const start=text.search(/<!doctype\s+html|<html[\s>]/i); if(start<0) throw new Error('模型没有返回完整 HTML 文档。可查看输出详情，或调整问题后重试。'); return text.slice(start); }
function preview(html) {
  const doc=new DOMParser().parseFromString(html,'text/html');
  // Model-supplied CSP or base tags must not weaken the host policy.
  doc.querySelectorAll('meta[http-equiv],base').forEach(el=>el.remove());
  const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";doc.head.prepend(policy);
  const bridge=doc.createElement('script');bridge.textContent=`addEventListener('error',e=>parent.postMessage({labError:String(e.message)},'*'));addEventListener('unhandledrejection',e=>parent.postMessage({labError:String(e.reason)},'*'));document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault()});`;
  policy.after(bridge);$('runtime').textContent='';$('frame').srcdoc='<!doctype html>'+doc.documentElement.outerHTML;
}
window.addEventListener('message',event=>{if(event.source===$('frame').contentWindow&&typeof event.data?.labError==='string') $('runtime').textContent+=`运行错误：${event.data.labError.slice(0,500)}\n`;});
function tab(source) { $('frame').hidden=source||active<0; $('source').hidden=!source||active<0; $('sourceActions').hidden=!source||active<0; $('previewTab').setAttribute('aria-pressed',String(!source));$('sourceTab').setAttribute('aria-pressed',String(source)); }
$('previewTab').onclick=()=>tab(false);$('sourceTab').onclick=()=>tab(true);
function select(index) { active=index;const r=records[index];$('empty').hidden=true;$('source').value=r.html;preview(r.html);$('details').textContent=JSON.stringify({model:r.model,seconds:r.seconds,finishReason:r.finishReason,usage:r.usage,reasoning:r.reasoning},null,2);tab(false);renderHistory();controls(); }
function renderHistory() { $('history').replaceChildren();records.forEach((r,i)=>{const b=document.createElement('button');b.className='record'+(i===active?' active':'');b.textContent=`${String(i+1).padStart(2,'0')} · ${r.prompt.slice(0,75)}`;const small=document.createElement('small');small.textContent=`${r.model} · ${r.seconds}s · ${r.time}`;b.append(small);b.onclick=()=>select(i);$('history').append(b);}); }
async function requestModel(data, path, onProgress) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Request':'1'},body:JSON.stringify({...data,clientStream:true}),signal:AbortSignal.timeout(610000)});
  if(!response.ok) { const result=await response.json();throw new Error(result.error||'请求失败'); }
  // Retain compatibility if an older local server is still running.
  if(!response.headers.get('content-type')?.includes('ndjson'))return response.json();
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let buffer='', result=null, partial={content:'',reasoning:''},lastDetail=0;
  function event(line) {
    if(!line.trim())return;
    const item=JSON.parse(line);
    if(item.type==='delta') {partial.content+=item.content||'';partial.reasoning+=item.reasoning||'';}
    if(item.type==='error')throw new Error(item.error);
    if(item.type==='result')result=item;
    onProgress(item,partial);
    if(performance.now()-lastDetail>150||result) {$('details').textContent=JSON.stringify(result||{status:'接收中',...partial},null,2);lastDetail=performance.now();}
  }
  try {
    while(true) { const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);event(line);}if(done)break; }
    if(buffer.trim())event(buffer);
    if(!result)throw new Error('本机响应流提前结束，没有完成标记。已接收的输出保留在详情中。');
    return result;
  } catch(error) { $('details').textContent=JSON.stringify({error:error.message,...partial},null,2);throw error; }
  finally { await reader.cancel().catch(()=>{}); }
}
function configuration(messages) { return {...Object.fromEntries(configFields.map(id=>[id,$(id).value])),key:$('key').value,messages}; }
async function testConnection() {
  if(!$('base').value.trim()||!$('model').value.trim())return status('请填写 Base URL 和 Model ID。',true);
  busy=true;controls();const start=performance.now();let phase='正在连接';
  const timer=setInterval(()=>status(`${phase}…${Math.round((performance.now()-start)/1000)} 秒`),1000);
  status('正在测试连接：请求简短回复，不生成页面。');
  try { const result=await requestModel(configuration([{role:'user',content:'OK'}]),'/api/test',item=>{if(item.type==='connected')phase='接口已响应，等待简短回复';});$('details').textContent=JSON.stringify(result,null,2);status(`连接成功（${((performance.now()-start)/1000).toFixed(1)} 秒）：${result.content.slice(0,100)}`); }
  catch(error){status(error.message,true);}finally{clearInterval(timer);busy=false;controls();}
}
$('testConnection').onclick=testConnection;
async function generate(revise) {
  const prompt=$('prompt').value.trim();if(!prompt)return status('请先输入学习任务。',true);
  if(!$('base').value.trim()||!$('model').value.trim())return status('请填写 Base URL 和 Model ID。',true);
  const parent=revise?records[active]:null;
  const messages=parent?[{role:'user',content:parent.task},{role:'assistant',content:parent.html},{role:'user',content:prompt}]:[{role:'user',content:prompt}];
  const data=configuration(messages);
  busy=true;controls();const start=performance.now();let phase='正在连接模型',counts='';status('正在连接模型，输出将实时出现在详情中。');
  const timer=setInterval(()=>status(`${phase}…${Math.round((performance.now()-start)/1000)} 秒${counts}`),1000);
  try {
    const result=await requestModel(data,'/api/generate',(item,partial)=>{if(item.type==='connected')phase='接口已响应，等待输出';if(item.type==='delta'){phase=partial.content?'正在接收页面':'模型正在思考';counts=` · 正文 ${partial.content.length} 字符 / 思考 ${partial.reasoning.length} 字符`;} });
    $('details').textContent=JSON.stringify(result,null,2);
    const html=extract(result.content);const seconds=((performance.now()-start)/1000).toFixed(1);
    records.push({html,prompt,task:parent?`${parent.task}\n修改要求：${prompt}`:prompt,model:data.model,base:data.base,protocol:data.protocol,effort:data.effort,maxTokens:data.maxTokens,seconds,time:new Date().toLocaleTimeString(),usage:result.usage,reasoning:result.reasoning,finishReason:result.finishReason});select(records.length-1);
    status(result.finishReason==='length'?'输出达到 token 上限，页面可能不完整。请提高上限或简化任务。':`生成完成，用时 ${seconds} 秒。请检查内容和控件是否正确。`,result.finishReason==='length');
  } catch(error) { status(error.message,true); } finally { clearInterval(timer);busy=false;controls(); }
}
$('generate').onclick=()=>generate(false);$('revise').onclick=()=>generate(true);
$('apply').onclick=()=>{const parent=records[active];records.push({...parent,html:$('source').value,prompt:'手动修改源码',time:new Date().toLocaleTimeString()});select(records.length-1);status('已保存手动修改为新版本。');};
function download(text,name,type) {const a=document.createElement('a');const url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download').onclick=()=>download(records[active].html,`learning-${active+1}.html`,'text/html');
$('export').onclick=()=>download(JSON.stringify({format:'reed-ui-lab-v1',records},null,2),'ui-lab-records.json','application/json');
window.addEventListener('beforeunload',event=>{if(records.length||busy){event.preventDefault();event.returnValue='';}});
