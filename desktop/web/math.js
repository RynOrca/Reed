import katex from './vendor/katex.mjs';
import {isCodeIdentifier} from './math-auto.js';

// 实测会出现“反斜杠整段消失”的公式：模型把 \\lambda 写成 lambda、\\pmod 写成 pmod，
// 于是 KaTeX 把命令名拆成一个个字母（界面上就是 l a m b d a）。只在这类明确的
// 命令名整词出现、且整串里一个反斜杠都没有时补回，避免误改正常的数学与普通文字。
const latexWords=['alpha','beta','gamma','delta','epsilon','varepsilon','zeta','eta','theta','vartheta','iota','kappa','lambda','mu','nu','xi','pi','rho','sigma','tau','upsilon','phi','varphi','chi','psi','omega','Gamma','Delta','Theta','Lambda','Xi','Pi','Sigma','Upsilon','Phi','Psi','Omega','equiv','pmod','bmod','cdot','times','div','pm','mp','leq','le','geq','ge','neq','ne','approx','sim','cong','propto','infty','partial','nabla','sum','prod','int','sqrt','frac','dfrac','tfrac','binom','overline','underline','hat','bar','vec','dot','ddot','text','mathrm','mathbf','mathbb','mathcal','operatorname','left','right','begin','end','pmatrix','bmatrix','matrix','cases','quad','qquad','to','rightarrow','leftarrow','Rightarrow','Leftarrow','mapsto','forall','exists','neg','land','lor','in','notin','subset','subseteq','supset','cup','cap','emptyset','log','ln','exp','lim','max','min','gcd','lcm','mod','pmod','circ','ast','star','oplus','otimes','langle','rangle','lfloor','rfloor','lceil','rceil','ldots','cdots','vdots','ddots'];
const latexWordSet=new Set(latexWords);
// 只有这些词几乎不可能作为普通英文/中文文本出现，命中两个以上才认为公式被剥掉了反斜杠。
const strongSignals=new Set(['equiv','pmod','bmod','cdot','lambda','mu','pmatrix','bmatrix','vmatrix','mathbb','mathcal','mathrm','operatorname','binom','dfrac','tfrac','leqslant','geqslant','varnothing','mapsto','Longleftrightarrow','Leftrightarrow','longrightarrow']);
export function restoreLatexCommands(expression){
  const source=String(expression??'');
  if(!source||source.includes('\\'))return source;
  const words=source.match(/[A-Za-z]{2,}/g)||[];
  const hits=words.filter(word=>latexWordSet.has(word));
  if(hits.length<2)return source;
  if(!hits.some(word=>strongSignals.has(word))&&!hits.some(word=>source.includes('^'+word)||source.includes('_'+word)))return source;
  return source.replace(/[A-Za-z]{2,}/g,word=>latexWordSet.has(word)?'\\'+word:word);
}
// 反向的问题同样实测出现过：载荷里命令名前面有两个反斜杠（\\equiv）。LaTeX 里 \\ 是换行，
// 于是 KaTeX 把 equiv 当正文排出来，公式就变成一串字母。只看“反斜杠 + 已知命令名”：
// 命令名前面留一个反斜杠，其余字符（包括刻意的 \\ 换行）原样保留。
export function normalizeLatexEscapes(expression){
  const source=String(expression??'');
  if(!source.includes('\\'))return restoreLatexCommands(source);
  return source.replace(/\\+([A-Za-z]+)/g,(match,name)=>latexWordSet.has(name)?'\\'+name:match);
}

export function renderMath(expression,{display=false}={}){
  // 模型偶尔把字段名显式包进 $...$；它并不是字母相乘或下标。
  if(isCodeIdentifier(expression)){const code=document.createElement('code');code.textContent=String(expression).trim();return code;}
  const node=document.createElement(display?'div':'span');node.className=display?'reed-math reed-math-display':'reed-math';
  const raw=String(expression??'').trim();
  const wrapped=/^\$\$([\s\S]+)\$\$$/.exec(raw)||/^\$([^$]+)\$$/.exec(raw)||/^\\\[([\s\S]+)\\\]$/.exec(raw)||/^\\\(([\s\S]+)\\\)$/.exec(raw);
  if(wrapped&&isCodeIdentifier(wrapped[1])){const code=document.createElement('code');code.textContent=wrapped[1].trim();return code;}
  const source=normalizeLatexEscapes(wrapped?wrapped[1]:raw);
  try{
    if(!source.trim()||source.length>4000)throw Error('公式长度无效');
    // Only KaTeX's untrusted-input MathML output enters the DOM, never model HTML.
    // 单个不认识的命令不能让整条公式（连同整块图解）降级：让它只标红那一处，
    // 其余部分照常排版；整串无法解析时才退回文字。
    katex.render(source,node,{displayMode:display,output:'mathml',throwOnError:false,errorColor:'#c98f8f',trust:false,maxExpand:200,maxSize:10,strict:'ignore',macros:{}});
    if(!node.querySelector('math'))throw Error('未产出数学结构');
  }catch{node.textContent=source;node.classList.add('reed-math-fallback');node.title='公式暂时无法排版，保留原文';}
  return node;
}

// 重点标记：==高亮== 与 ++虚线下划线++。模型用它标出关键结论或术语，
// 渲染成无行为的 span，颜色由学习块/正文样式决定。
export function emphasisExtension(){return {extensions:[
  {name:'reedHighlight',level:'inline',start:src=>src.indexOf('=='),tokenizer(src){
    const m=/^==(?![=])([\s\S]+?)==(?![=])/.exec(src);
    if(m)return {type:'reedEmphasis',raw:m[0],kind:'hl',text:m[1]};
  }},
  {name:'reedWave',level:'inline',start:src=>src.indexOf('++'),tokenizer(src){
    const m=/^\+\+(?!\+)([\s\S]+?)\+\+(?!\+)/.exec(src);
    if(m)return {type:'reedEmphasis',raw:m[0],kind:'wave',text:m[1]};
  }},
]};}

export function mathExtension(){return {extensions:[
  {name:'reedBlockMath',level:'block',start:src=>src.search(/(?:^|\n)[ \t]*(?:\$\$|\\\[)/),tokenizer(src){
    const m=/^[ \t]*\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(src)||/^[ \t]*\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(src);
    if(m)return {type:'reedBlockMath',raw:m[0],text:m[1]};
  }},
  {name:'reedInlineMath',level:'inline',start:src=>src.search(/\$|\\(?:\(|\[)/),tokenizer(src){
    const m=/^\$\$([^\n]+?)\$\$/.exec(src)||/^\\\[([^\n]+?)\\\]/.exec(src)||/^\\\(([^\n]+?)\\\)/.exec(src)||/^\$(?!\$)([^\s$](?:[^\n$]*?[^\s$])?)\$(?!\$|\d)/.exec(src);
    if(m)return {type:'reedInlineMath',raw:m[0],text:m[1]};
  }},
]};}
