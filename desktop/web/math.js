import katex from './vendor/katex.mjs';

export function renderMath(expression,{display=false}={}){
  const node=document.createElement(display?'div':'span');node.className=display?'reed-math reed-math-display':'reed-math';
  const source=String(expression||'');
  try{
    if(!source.trim()||source.length>4000)throw Error('公式长度无效');
    // Only KaTeX's untrusted-input MathML output enters the DOM, never model HTML.
    katex.render(source,node,{displayMode:display,output:'mathml',throwOnError:true,trust:false,maxExpand:200,maxSize:10,strict:'ignore',macros:{}});
  }catch{node.textContent=source;node.classList.add('reed-math-fallback');node.title='公式暂时无法排版，保留原文';}
  return node;
}

export function mathExtension(){return {extensions:[
  {name:'reedBlockMath',level:'block',start:src=>src.search(/(?:^|\n)[ \t]*(?:\$\$|\\\[)/),tokenizer(src){
    const m=/^[ \t]*\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(src)||/^[ \t]*\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(src);
    if(m)return {type:'reedBlockMath',raw:m[0],text:m[1]};
  }},
  {name:'reedInlineMath',level:'inline',start:src=>src.search(/\$(?!\$)|\\\(/),tokenizer(src){
    const m=/^\\\(([^\n]+?)\\\)/.exec(src)||/^\$(?!\$)([^\s$](?:[^\n$]*?[^\s$])?)\$(?!\$|\d)/.exec(src);
    if(m)return {type:'reedInlineMath',raw:m[0],text:m[1]};
  }},
]};}
