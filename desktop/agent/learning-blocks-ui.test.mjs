import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderLearning,createLearningView,isLearningSpec} from '../web/learning-blocks.js';
import {splitLearningLiterals,stripLearningMarkup,hasLearningMarkup,renderAssistantMarkdown} from '../web/learning-literals.js';
import {renderMarkdown} from '../web/markdown.js';

// 这些用例直接跑真实前端模块，因此需要一个够用的 DOM 桩：只实现渲染器用到的部分。
class El {
  constructor(tag){this.tagName=String(tag).toUpperCase();this.children=[];this.attributes={};this.dataset={};this.style={};this.className='';this._text='';this.hidden=false;this.classList={add:n=>{if(!this.className.split(' ').includes(n))this.className=(this.className+' '+n).trim();},toggle:()=>{},contains:()=>false};}
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

test('正常正文不经过恢复路径',()=>{
  const root=new El('div');
  assert.equal(renderAssistantMarkdown(root,'普通 **Markdown** 段落。',renderMarkdown,{}),false);
  assert.ok(root.textContent.includes('普通'));
  assert.equal(isLearningSpec({...base,blocks:[samples.fill]}),true);
  assert.equal(isLearningSpec({...base,blocks:[{id:'x',type:'chart'}]}),false);
});
