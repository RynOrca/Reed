import {renderMarkdown,renderInline} from './markdown.js';
export function installAssessments(materials,{tauri,onError,sessionId}){
  const {pane,q,ask,command,status,current}=materials,bar=document.createElement('div');bar.className='materials-tools';
  const buttons={};for(const [id,label]of [['import','导入题库'],['bank','题库抽卷'],['generate','生成新模拟题'],['history','历史试卷'],['stop','停止出卷 / 评分']]){const button=document.createElement('button');button.type='button';button.textContent=label;bar.append(button);buttons[id]=button;}
  q('assessment').before(bar);buttons.stop.hidden=true;let paper=null,working=false,requestRevision=0;
  const drafts=new Map();
  function draft(id){if(drafts.has(id))return drafts.get(id);let value={};try{value=JSON.parse(localStorage.getItem('reed-paper-draft:'+id)||'{}');}catch{}drafts.set(id,value);return value;}
  function saveDraft(id,value){drafts.set(id,value);try{localStorage.setItem('reed-paper-draft:'+id,JSON.stringify(value));}catch{}}
  function setWorking(value){working=value;buttons.generate.disabled=value;buttons.bank.disabled=value;buttons.import.disabled=value;buttons.stop.hidden=!value;}
  function render(value){
    materials.suspendReading();paper=value;pane.classList.add('practice-mode');q('reader').hidden=true;const root=q('assessment');root.replaceChildren();
    const heading=document.createElement('h3');heading.textContent=value.title;const notice=document.createElement('p');notice.textContent=value.submitted?'已提交。简答题的模型评分供复核，生成题的参考答案也可能有误。':'先独立作答，提交后显示参考答案与解析。';
    const close=document.createElement('button');close.type='button';close.textContent='返回阅读';close.onclick=()=>{root.replaceChildren();q('reader').hidden=false;pane.classList.remove('practice-mode');paper=null;void materials.resumeReading();};root.append(heading,notice,close);
    const form=document.createElement('form'),answers=value.answers||draft(value.id);
    for(const [index,question]of value.questions.entries()){
      const block=document.createElement('section');block.className='practice-question';const title=document.createElement('h4');title.textContent=`${index+1}. ${question.points} 分`;const body=document.createElement('div');renderMarkdown(body,question.prompt);block.append(title,body);
      if(question.type==='choice')for(const option of question.options){const label=document.createElement('label'),radio=document.createElement('input'),text=document.createElement('span');radio.type='radio';radio.name=question.id;radio.value=option.id;radio.required=true;radio.checked=answers[question.id]===option.id;radio.disabled=value.submitted;renderInline(text,option.id+'．'+option.text);label.append(radio,text);block.append(label);}
      else{const input=document.createElement('textarea');input.name=question.id;input.rows=4;input.maxLength=5000;input.required=true;input.value=answers[question.id]||'';input.disabled=value.submitted;input.setAttribute('aria-label',`第 ${index+1} 题作答`);block.append(input);}
      if(value.submitted){const grade=value.grading.find(g=>g.id===question.id);const result=document.createElement('div');result.className='practice-result';renderMarkdown(result,`得分：${grade.score} / ${question.points}\n\n参考答案：${grade.answer}\n\n${grade.explanation}${grade.feedback?'\n\n评分依据：'+grade.feedback:''}${grade.references?.length?'\n\n参考：'+grade.references.map(r=>`[PDF 第 ${r.pageIndex+1} 页](reed-material:${r.documentId}#page=${r.pageIndex+1})`).join('、'):''}`);block.append(result);}
      form.append(block);
    }
    form.oninput=()=>saveDraft(value.id,Object.fromEntries(new FormData(form)));
    if(!value.submitted){const submit=document.createElement('button');submit.type='submit';submit.textContent='提交并查看解析';form.append(submit);const hint=document.createElement('small');hint.textContent='简答题评分可能调用当前模型。';form.append(hint);
      form.onsubmit=event=>{event.preventDefault();if(working||!form.reportValidity())return;const answers=Object.fromEntries(new FormData(form));saveDraft(value.id,answers);const owner=sessionId(),ticket=++requestRevision;setWorking(true);submit.disabled=true;status('正在提交并评分…');
        void command('materials_paper_submit',{paperId:value.id,answers}).then(result=>{if(owner===sessionId()&&ticket===requestRevision){render(result);status('评分已保存，可在历史试卷中查看。');}}).catch(onError).finally(()=>{if(ticket===requestRevision){setWorking(false);submit.disabled=false;}});
      };
    }else{const total=document.createElement('p');total.textContent=`总分：${value.grading.reduce((n,g)=>n+g.score,0)} / ${value.questions.reduce((n,g)=>n+g.points,0)}`;form.prepend(total);}
    root.append(form);
  }
  async function conditions(title){return ask(title,[{name:'topic',label:'考点范围（留空沿用当前教材已读内容）',required:false},{name:'count',label:'题目数量（1 到 10）',value:'5'},{name:'type',label:'题型',options:[['mixed','混合题型'],['choice','选择题'],['short','简答题']]}]);}
  for(const mode of ['bank','generate'])buttons[mode].onclick=()=>void(async()=>{
    if(working)return;const owner=sessionId(),options=await conditions(mode==='bank'?'从题库抽卷':'生成新模拟题（使用当前模型）');if(!options||owner!==sessionId())return;
    options.count=Number(options.count);const scene=current();if(mode==='generate'&&scene){options.documentId=scene.document.id;options.maxPage=scene.pageIndex;}
    const ticket=++requestRevision;setWorking(true);status(mode==='generate'?'正在参考当前科目教材与真题生成新题…':'正在从题库组卷…');
    try{const value=await command(mode==='bank'?'materials_paper_bank':'materials_paper_generate',{options});if(owner===sessionId()&&ticket===requestRevision){render(value);status('试卷已保存，参考答案在提交后显示。');}}
    finally{if(ticket===requestRevision)setWorking(false);}
  })().catch(onError);
  buttons.import.onclick=()=>void(async()=>{const path=await tauri.core.invoke('choose_html_file');if(!path)return;const result=await command('materials_bank_import',{path});status(`已处理 ${result.count} 道题，重复题不会重复导入。`);})().catch(onError);
  buttons.history.onclick=()=>void(async()=>{const owner=sessionId(),result=await command('materials_paper_list');if(!result.papers.length){status('当前科目还没有试卷。');return;}const selection=await ask('打开试卷',[{name:'paperId',label:'当前科目试卷',options:result.papers.map(p=>[p.id,p.title+(p.submitted_at?' · 已提交':' · 待作答')])}]);if(selection&&owner===sessionId())render(await command('materials_paper_open',selection));})().catch(onError);
  buttons.stop.onclick=()=>void command('materials_paper_cancel').catch(onError);
  pane.addEventListener('material-session',()=>{requestRevision++;paper=null;setWorking(false);q('assessment').replaceChildren();q('reader').hidden=false;pane.classList.remove('practice-mode');});
  materials.showPaper=async value=>{await materials.show();render(value);};
}
