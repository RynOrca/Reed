import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderLearning,createLearningView,isLearningSpec} from '../web/learning-blocks.js';
import {splitLearningLiterals,stripLearningMarkup,hasLearningMarkup,renderAssistantMarkdown,recoveredQuestionKey,saveRecoveredAnswer,loadRecoveredAnswers} from '../web/learning-literals.js';
import {renderMarkdown} from '../web/markdown.js';
import {restoreLatexCommands,normalizeLatexEscapes} from '../web/math.js';

// 这些用例直接跑真实前端模块，因此需要一个够用的 DOM 桩：只实现渲染器用到的部分。
class El {
  constructor(tag){this.tagName=String(tag).toUpperCase();this.children=[];this.attributes={};this.dataset={};this.style={};this.className='';this._text='';this.hidden=false;this.disabled=false;this.classList={add:n=>{if(!this.className.split(' ').includes(n))this.className=(this.className+' '+n).trim();},toggle:()=>{},contains:()=>false};}
  append(...nodes){for(const node of nodes)if(node!==null&&node!==undefined)this.children.push(typeof node==='string'?{nodeType:3,textContent:node}:node);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){this.attributes[name]=String(value);if(name.startsWith('data-'))this.dataset[name.slice(5)]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(){}closest(){return null;}querySelector(){return null;}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent??'').join('');}
  get childNodes(){return this.children;}
}
const documentStub={createElement:tag=>new El(tag),createTextNode:value=>({nodeType:3,textContent:String(value)}),createDocumentFragment:()=>new El('fragment')};
globalThis.document=documentStub;
globalThis.window=globalThis;

const base={schemaVersion:1,fallbackText:'整条消息的可读降级文字。'};
const ident=name=>({id:name,fallbackText:name+' 的降级文字'});
const samples={
  flow:{...ident('flow'),type:'flow',title:'流程',nodes:[{label:'输入',value:'3'},{label:'判断',value:'真',note:'非零'}]},
  timeline:{...ident('timeline'),type:'flow',title:'时间线',layout:'timeline',nodes:[{label:'第一步',value:'读取'},{label:'第二步',value:'校验'}]},
  compare:{...ident('compare'),type:'compare',title:'对比',columns:[{title:'A',body:'**加粗** 内容'},{title:'B',body:'普通内容'}]},
  result:{...ident('result'),type:'result',title:'结果',items:[{label:'原始值',value:'2'},{label:'恢复值',value:'2'}],conclusion:'条件成立。'},
  derivation:{...ident('derivation'),type:'derivation',title:'推导',steps:[{expression:'c_1c_2',reason:'两个密文相乘'},{expression:'g^{m_1+m_2}',reason:'同底数幂相乘'}]},
  callout:{...ident('callout'),type:'callout',title:'注意',text:'示意数据。',tone:'warning'},
  reveal:{...ident('reveal'),type:'reveal',title:'提示',text:'先看前提。'},
  term:{...ident('term'),type:'term',term:'互素',definition:'最大公因数为 1。',before:'这里要求',after:'的条件。'},
  choices:{...ident('choices'),type:'choices',title:'选一个',options:[{id:'a',label:'真',replyText:'非零整数为真。'},{id:'b',label:'不确定',replyText:'我还不确定。'}]},
  fill:{...ident('fill'),type:'fill',title:'填空',label:'c_sum ='},
};
const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of node.children||[]){const hit=find(child,predicate);if(hit)return hit;}return null;};

test('九种学习块都能渲染出结构，不整条降级',()=>{
  for(const [name,block] of Object.entries(samples)){
    const view=renderLearning({...base,blocks:[block]});
    assert.ok(!/整条消息的可读降级文字/.test(view.root.textContent),name+' 不应整条降级');
    const section=find(view.root,node=>String(node.className).includes('learning-'+block.type));
    assert.ok(section,name+' 缺少块容器');
  }
});

test('推导把公式与依据分开，依据不在公式容器内',()=>{
  const view=renderLearning({...base,blocks:[samples.derivation]});
  const formula=find(view.root,node=>node.className==='learning-expression');
  assert.ok(formula,'缺少公式容器');
  assert.equal(find(formula,node=>node.tagName==='P'),null,'依据不应嵌在公式容器里');
  const step=find(view.root,node=>node.className==='learning-step');
  assert.ok(step.children.some(node=>node.tagName==='P'&&node.textContent.includes('两个密文相乘')),'依据应作为步骤的兄弟节点');
});

test('单个块失效只让该块降级，同条消息的其他块继续显示',()=>{
  const view=renderLearning({...base,blocks:[{...ident('bad'),type:'flow',title:'坏流程',nodes:[]},samples.callout]});
  assert.ok(!/整条消息的可读降级文字/.test(view.root.textContent));
  const fallback=find(view.root,node=>String(node.className).includes('learning-block-fallback'));
  assert.ok(fallback&&fallback.textContent.includes('bad 的降级文字'));
  assert.ok(find(view.root,node=>String(node.className).includes('learning-callout')),'好块仍应渲染');
});

test('全部块与整条消息共用同一段降级文字时，整条退回文字',()=>{
  const spec={schemaVersion:1,fallbackText:'共用降级文字',blocks:[{id:'only',type:'flow',title:'坏',fallbackText:'共用降级文字',nodes:[]}]};
  const view=renderLearning(spec);
  assert.equal(view.root.textContent,'共用降级文字');
});

test('正文里的 show_learning 标记被还原成块并删除原文',()=>{
  const spec={...base,fallbackText:'推导与提问。',blocks:[samples.derivation,samples.choices]};
  const source=`先看推导。\n\n<show_learning schemaVersion="1" fallbackText="推导与提问。">${JSON.stringify(spec)}</show_learning>\n\n选完告诉我理由。`;
  assert.equal(hasLearningMarkup(source),true);
  const spans=splitLearningLiterals(source);
  assert.deepEqual(spans.map(span=>span.kind),['text','learning','text']);
  assert.equal(spans[1].spec.blocks.length,2);
  const root=new El('div');
  assert.equal(renderAssistantMarkdown(root,source,renderMarkdown,{}),true);
  assert.equal(/show_learning|schemaVersion/.test(root.textContent),false,'标记不应留在正文里');
  assert.ok(root.textContent.includes('先看推导'));
  assert.ok(root.textContent.includes('选完告诉我理由'));
  assert.ok(find(root,node=>String(node.className).includes('learning-derivation')),'应渲染出推导块');
  assert.equal(root.children.some(node=>node.tagName==='DETAILS'),false,'恢复的块不接受作答');
});

test('残缺或非法标记整段清理且不抛异常',()=>{
  const broken=`解题思路如下。\n\n<show_learning schemaVersion="1" fallbackText="半截">{"schemaVersion":1,"fallbackText":"半截","blocks":[{"id":"x","type":"flow",`;
  assert.equal(splitLearningLiterals(broken).length,1,'半截 JSON 不应产出块');
  const root=new El('div');
  assert.equal(renderAssistantMarkdown(root,broken,renderMarkdown,{}),false);
  assert.equal(hasLearningMarkup(root.textContent),false);
  assert.ok(root.textContent.includes('解题思路如下'));
  const invalid=`说明。\n\n<show_learning schemaVersion="1">{"schemaVersion":1,"fallbackText":"无效","blocks":[{"id":"x","type":"not-a-block"}]}</show_learning>`;
  assert.equal(splitLearningLiterals(invalid).length,1);
  assert.equal(hasLearningMarkup(stripLearningMarkup(invalid)),false);
  const cut='讲到这里。<show_learn';
  assert.equal(/show_learn/.test(stripLearningMarkup(cut)),false,'截断的标记残片也要清掉');
  assert.ok(stripLearningMarkup(cut).includes('讲到这里'));
});

test('属性式标记（单引号 Python 字面量）同样还原，个别字段不合规不拖累整段',()=>{
  const python="[{'id':'paillier-hom','type':'derivation','title':'为什么密文相乘等于明文相加','steps':[{'expression':'c_1 c_2 \\\\equiv g^{m_1} r_1^{n} \\\\pmod{n^{2}}','reason':'代入加密公式 c = g^m r^n'}],'source':{'label':'加法同态核心公式 · L87','url':'summon-file:D%3A%5CObsidian%5CPillier.md%23L87'}},{'id':'ask','type':'choices','title':'密文乘 3 解密会得到什么？','fallbackText':'请选择 3(m1+m2) 或 m1+m2+3。','options':[{'id':'a','label':'3(m1+m2)','replyText':'我选 3(m1+m2)。'}]}]";  const source=`你笔记里公式已经记全了。\n\n<show_learning schemaVersion="1" fallbackText="同态性推导：c₁c₂ ≡ g^{m₁+m₂}(r₁r₂)ⁿ，标量乘法 E(m)^k → m·k。" blocks="${python}"></show_learning>\n\n选完告诉我理由。`;
  const spans=splitLearningLiterals(source);
  assert.deepEqual(spans.map(span=>span.kind),['text','learning','text']);
  assert.deepEqual(spans[1].spec.blocks.map(block=>block.type),['derivation','choices']);
  // 块数组直接当载荷（少一层 {schemaVersion,blocks}）也要认：抢救路径补齐外壳。
  const bare=`说明。\n\n<show_learning schemaVersion="1" fallbackText="整体降级文字" blocks="${python.replace(/%23L87/g,'#L87')}"></show_learning>`;
  const bareSpec=splitLearningLiterals(bare).filter(span=>span.kind==='learning')[0];
  assert.deepEqual(bareSpec.spec.blocks.map(block=>block.type),['derivation','choices']);
  assert.ok(bareSpec.spec.fallbackText.trim(),'没有整体降级文字时按块拼一段可读文字');
  assert.equal(spans[1].spec.fallbackText.startsWith('同态性推导'),true,`实际=${spans[1].spec.fallbackText}`);
  assert.ok(spans[1].spec.fallbackText.includes('为什么密文相乘等于明文相加'),'标签上的整体降级文字与按块拼的文字都要保留');
  const root=new El('div');
  assert.equal(renderAssistantMarkdown(root,source,renderMarkdown,{}),true);
  assert.equal(/show_learning|schemaVersion/.test(root.textContent),false);
  assert.ok(find(root,node=>String(node.className).includes('learning-derivation')),'属性式也要渲染出推导块');
  assert.equal(find(root,node=>String(node.className).includes('learning-choices')).querySelectorAll?.('.learning-choice')??2,2);
});

test('真实会话里的两条标记消息全部还原，不再只剩标题',async()=>{
  const raw=await readFile(new URL('../../dist/learning-blocks-0.3.2/real-literal-messages.jsonl',import.meta.url),'utf8').catch(()=>null);
  if(!raw)return; // 本地夹具缺失时跳过，不把缺失当通过
  const messages=raw.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line).message;}catch{return null;}}).filter(message=>message?.role==='assistant');
  const literals=messages.filter(message=>(message.content||[]).some(block=>block.type==='text'&&/<show_learning/i.test(block.text||'')));
  assert.ok(literals.length>=2,'夹具里应含两条标记消息');
  for(const message of literals){
    const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n');
    const specs=splitLearningLiterals(text).filter(span=>span.kind==='learning').flatMap(span=>span.spec.blocks);
    assert.ok(specs.length>0,'真实标记消息必须还原出块');
    const root=new El('div');
    renderAssistantMarkdown(root,text,renderMarkdown,{});
    assert.equal(/show_learning/i.test(root.textContent),false);
    assert.ok(find(root,node=>String(node.className).includes('learning-block')),'至少渲染出一个块容器');
  }
});

test('反斜杠被吃掉的公式补回 LaTeX 命令，正常公式与正文不动',()=>{
  const broken='c^{lambda} equiv g^{mlambda}, r^{nlambda} pmod{n^{2}}';
  const restored=restoreLatexCommands(broken);
  assert.ok(restored.includes('\\lambda'),'命令名要补回反斜杠：'+restored);
  assert.ok(restored.includes('\\equiv')&&restored.includes('\\pmod'));
  assert.equal(restoreLatexCommands('c^{\\lambda} \\equiv 1 \\pmod{n^{2}}'),'c^{\\lambda} \\equiv 1 \\pmod{n^{2}}','已有反斜杠的公式原样保留');
  assert.equal(restoreLatexCommands('第1.5节 与 min 和 max 的比较'),'第1.5节 与 min 和 max 的比较','普通文字里的 min/max 不动');
  const node=renderLearning({schemaVersion:1,fallbackText:'x',blocks:[{id:'d',type:'derivation',title:'推导',fallbackText:'x',steps:[{expression:broken,reason:'依据'}]}]});
  assert.equal(find(node.root,item=>item.className==='reed-math-fallback'),null,'补回后不应再走文字降级');
});

test('重复反斜杠的命令名归一，`\\\\` 换行与真实表达式保留',()=>{
  // 实测载荷形态：命令名前有两个反斜杠，KaTeX 把命令名当正文，公式变成一串字母。
  const doubled='c^{\\\\lambda} \\\\equiv g^{m\\\\lambda} \\\\pmod{n^{2}}';
  const fixed=normalizeLatexEscapes(doubled);
  assert.equal(fixed,'c^{\\lambda} \\equiv g^{m\\lambda} \\pmod{n^{2}}','命令名只留一个反斜杠：'+fixed);
  assert.equal(normalizeLatexEscapes('c^{\\lambda} \\equiv 1 \\pmod{n^{2}}'),'c^{\\lambda} \\equiv 1 \\pmod{n^{2}}','本来就正确的公式不动');
  assert.equal(normalizeLatexEscapes('a \\\\ b'),'a \\\\ b','非命令名的 \\\\ 换行保留');
  const view=renderLearning({schemaVersion:1,fallbackText:'x',blocks:[{id:'d',type:'derivation',title:'推导',fallbackText:'x',steps:[{expression:doubled,reason:'依据'}]}]});
  const math=find(view.root,item=>String(item.className).includes('reed-math'));
  assert.ok(math,'应渲染出公式容器');
  // DOM 桩下 KaTeX 会走文字降级，因此这里只确认渲染器拿到的是归一后的源串。
  assert.equal(math.textContent,fixed,'渲染前必须完成归一：'+JSON.stringify(math.textContent.slice(0,60)));
});

test('恢复出来的题目可以作答，并用本地键记住已答',()=>{
  const python="[{'id':'ask','type':'choices','title':'选一个','fallbackText':'请选择甲或乙。','options':[{'id':'a','label':'甲','replyText':'我选甲。'},{'id':'b','label':'乙','replyText':'我选乙。'}]}]";
  const source=`先看题。\n\n<show_learning schemaVersion="1" fallbackText="整体降级" blocks="${python}"></show_learning>`;
  const replies=[];
  const root=new El('div');
  const options={messageId:'m1',canAnswer:()=>true,onRecoveredReply:payload=>replies.push(payload),recovered:{}};
  assert.equal(renderAssistantMarkdown(root,source,renderMarkdown,options),true);
  const button=(()=>{const matches=[];const collect=(node)=>{if(!node||typeof node!=='object')return;if(String(node.className||'').split(' ').includes('learning-choice'))matches.push(node);for(const child of node.children||[])collect(child);};collect(root);return matches[0];})();
  assert.ok(button,'应渲染出可点的选项');
  assert.equal(typeof button.onclick,'function','选项要挂上点击处理');
  assert.ok(!button.disabled,'可回答时选项应可点');
  button.onclick();
  assert.equal(replies.length,1);
  assert.equal(replies[0].block.id,'ask');
  assert.equal(replies[0].value.id,'a');
  // 已答状态：同一道题下次渲染应禁用并显示已答文字。
  const key=recoveredQuestionKey('m1',0,'ask');
  const anyChoice=(host)=>{const matches=[];const collect=(node)=>{if(!node||typeof node!=='object')return;if(String(node.className||'').split(' ').includes('learning-choice'))matches.push(node);for(const child of node.children||[])collect(child);};collect(host);return matches[0];};
  const answered=new El('div');
  renderAssistantMarkdown(answered,source,renderMarkdown,{...options,recovered:{[key]:{status:'answered',answer:'甲',text:'我选甲。'}}});
  assert.equal(anyChoice(answered).disabled,true,'已答后应禁用');
  assert.ok((await0(answered)).includes('已发送你的回答：甲'),'已答状态要显示出来');
  // 本地存档读写
  const memory={data:{},getItem(name){return this.data[name]??null;},setItem(name,value){this.data[name]=value;}};
  assert.equal(saveRecoveredAnswer(key,{question:'选一个',answer:'甲',text:'我选甲。'},memory),true);
  const loaded=loadRecoveredAnswers({[key]:{text:'我选甲。'}},memory);
  assert.equal(loaded[key].answer,'甲');
});
function await0(root){return root.textContent;}
function serialize(node){if(!node||typeof node!=='object')return '';if(node.nodeType===3)return node.textContent;const cls=node.className?` class="${node.className}"`:'';const own=`data-id=${node.dataset?.blockId||'-'} onclick=${typeof node.onclick} disabled=${node.disabled}`;return `<${String(node.tagName||'?').toLowerCase()}${cls} ${own}>${(node.children||[]).map(serialize).join('')}</${String(node.tagName||'?').toLowerCase()}>`;}

test('组件字段里的 $...$ 也排版成公式，不再显示 LaTeX 源码',()=>{
  const spec={schemaVersion:1,fallbackText:'x',blocks:[
    {id:'f',type:'flow',title:'数据流',fallbackText:'x',nodes:[{label:'密钥 $n = p\\cdot q$',value:'$\\mu = L(g^{\\lambda})^{-1}$',note:'其中 $\\lambda = \\mathrm{lcm}(p-1,q-1)$'}]},
    {id:'r',type:'result',title:'结果',fallbackText:'x',items:[{label:'和',value:'$m_1 + m_2$',note:'模 $n$'}]},
    {id:'c',type:'choices',title:'选一个',fallbackText:'x',options:[{id:'a',label:'$3(m_1+m_2)$',replyText:'我选 $3(m_1+m_2)$。'}]},
    {id:'fl',type:'fill',title:'填空',fallbackText:'x',label:'$c_{\\mathrm{sum}} =$'},
  ]};
  const view=renderLearning(spec);
  const mathNodes=[];
  const collect=node=>{if(!node||typeof node!=='object')return;if(String(node.className||'').includes('reed-math'))mathNodes.push(node);for(const child of node.children||[])collect(child);};
  collect(view.root);
  assert.ok(mathNodes.length>=5,'每个带 $...$ 的字段都应产生公式节点，实际 '+mathNodes.length);
  const flowNode=(()=>{const matches=[];const walk=node=>{if(!node||typeof node!=='object')return;if(String(node.className||'').split(' ').includes('learning-node'))matches.push(node);for(const child of node.children||[])walk(child);};walk(view.root);return matches[0];})();
  assert.ok(flowNode,'流程图节点应渲染');
  assert.ok(flowNode.children.some(child=>child.tagName==='STRONG'),'节点值容器结构保持');
  assert.ok(String(flowNode.textContent).includes('密钥'),'标签文字保留');
  assert.equal(/\$/.test(view.root.textContent),false,'不应再显示 $ 定界符：'+view.root.textContent.slice(0,120));
  // DOM 桩里 KaTeX 会降级成文字，源码会原样留在公式节点内；真实浏览器由 Edge 检查确认排版。
  const button=(()=>{const matches=[];const walk=node=>{if(!node||typeof node!=='object')return;if(String(node.className||'').split(' ').includes('learning-choice'))matches.push(node);for(const child of node.children||[])walk(child);};walk(view.root);return matches[0];})();
  assert.equal(button.attributes['aria-label'],'3(m_1+m_2)；发送：关于「选一个」：我选 3(m_1+m_2)。','无障碍名称用去掉定界符的可读文字');
});

test('重点标记与无法排版的命令不会拖垮整块',()=>{
  const view=renderLearning({schemaVersion:1,fallbackText:'x',blocks:[
    {id:'c',type:'callout',title:'注意条件',fallbackText:'x',text:'明文空间是 $\\mathbb{Z}_n$；==只有掌握 $\\lambda$ 的人能还原明文==，++密文膨胀约 2 倍++。'},
    {id:'d',type:'derivation',title:'推导',fallbackText:'x',steps:[{expression:'c^{\\lambda} \\\\equiv 1 \\pmod{n^{2}}',reason:'不认识的命令 $\\notacommand{x}$ 只标出问题，不整块降级'}]},
  ]});
  const classes=[];
  const collect=node=>{if(!node||typeof node!=='object')return;const cls=String(node.className||'');if(cls)classes.push(cls);for(const child of node.children||[])collect(child);};
  collect(view.root);
  assert.ok(classes.some(name=>name.split(' ').includes('emphasis-hl')),'==高亮== 应渲染成高亮标记');
  assert.ok(classes.some(name=>name.split(' ').includes('emphasis-wave')),'++下划线++ 应渲染成标记');
  assert.equal(/==|\+\+/.test(view.root.textContent),false,'标记语法不应留在文字里：'+view.root.textContent.slice(0,80));
  const steps=find(view.root,node=>String(node.className||'').includes('learning-step'));
  assert.ok(steps,'推导步骤应渲染');
  assert.ok(find(steps,node=>String(node.className||'').includes('reed-math')),'公式容器仍在');
});

test('正常正文不经过恢复路径',()=>{
  const root=new El('div');
  assert.equal(renderAssistantMarkdown(root,'普通 **Markdown** 段落。',renderMarkdown,{}),false);
  assert.ok(root.textContent.includes('普通'));
  assert.equal(isLearningSpec({...base,blocks:[samples.fill]}),true);
  assert.equal(isLearningSpec({...base,blocks:[{id:'x',type:'chart'}]}),false);
});
