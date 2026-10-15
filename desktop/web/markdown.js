import { marked } from "./vendor/marked.esm.js";

// Build DOM nodes from Marked tokens. Raw HTML is always displayed as text.
function inline(tokens = [], options = {}) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    let node;
    switch (token.type) {
      case "strong": node = document.createElement("strong"); node.append(inline(token.tokens,options)); break;
      case "em": node = document.createElement("em"); node.append(inline(token.tokens,options)); break;
      case "del": node = document.createElement("del"); node.append(inline(token.tokens,options)); break;
      case "codespan": node = document.createElement("code"); node.textContent = token.text; break;
      case "link": {
        const url = String(token.href || "");
        if (/^(https?:|mailto:)/i.test(url)) {
          node = document.createElement("a"); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; node.append(inline(token.tokens,options));
        } else if (/^(summon-file:|file:|[a-z]:[\\/]|[./\\])|\.(html?|md|txt|pdf)(#.*)?$/i.test(url) && !/^(javascript|data|vbscript):/i.test(url)) {
          node = document.createElement("a"); node.href = "#"; node.dataset.localFile = url; node.title = "在默认应用中打开本地文件"; node.append(inline(token.tokens,options));
        } else { node = document.createTextNode(token.text || url); }
        break;
      }
      case "br": node = document.createElement("br"); break;
      case "image": node = document.createTextNode(token.text || "[图片]"); break;
      case "text":
        if (token.tokens) { node = inline(token.tokens,options); break; }
        node = document.createDocumentFragment();
        {let end=0;const text=token.text||'';for(const match of text.matchAll(/\[\^([^\]\n]+)\]/g)){
          const definition=options.notes?.get(match[1]);if(!definition)continue;
          node.append(document.createTextNode(text.slice(end,match.index)));const link=document.createElement('a');link.className='note-citation';link.href='#'+definition.target;link.textContent='['+definition.number+']';link.title='查看引用来源';
          link.onclick=event=>{event.preventDefault();const target=document.getElementById(definition.target);target?.scrollIntoView({block:'nearest',behavior:'smooth'});target?.focus({preventScroll:true});};node.append(link);end=match.index+match[0].length;
        }node.append(document.createTextNode(text.slice(end)));}break;
      default: node = document.createTextNode(token.raw || token.text || "");
    }
    fragment.append(node);
  }
  return fragment;
}

function blocks(tokens = [], options = {}) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    let node;
    switch (token.type) {
      case "space": continue;
      case "checkbox": {
        node = document.createElement("input"); node.type = "checkbox"; node.checked = token.checked;
        const index = options.taskIndex ? options.taskIndex.value++ : 0;
        node.disabled = !options.onTask;
        node.setAttribute("aria-label", `学习小目标 ${index+1}`);
        if (options.onTask) node.onchange = () => options.onTask(index,node.checked);
        break;
      }
      case "heading": node = document.createElement(`h${Math.min(6, Math.max(1, token.depth))}`); node.append(inline(token.tokens,options)); break;
      case "paragraph": node = document.createElement("p"); node.append(inline(token.tokens,options)); break;
      case "text": node = document.createElement("p"); node.append(inline(token.tokens || [{ type: "text", text: token.text }],options)); break;
      case "code": {
        node = document.createElement("pre"); const code = document.createElement("code"); code.textContent = token.text || "";
        if (token.lang) code.dataset.lang = token.lang;
        node.append(code); break;
      }
      case "list": {
        node = document.createElement(token.ordered ? "ol" : "ul");
        if (token.ordered && token.start) node.start = token.start;
        for (const item of token.items || []) { const li = document.createElement("li"); if(item.task)li.className="task-list-item"; li.append(blocks(item.tokens,options)); node.append(li); }
        break;
      }
      case "blockquote": node = document.createElement("blockquote"); node.append(blocks(token.tokens,options)); break;
      case "hr": node = document.createElement("hr"); break;
      case "html": node = document.createElement("p"); node.textContent = token.text || token.raw || ""; break;
      case "table": {
        node = document.createElement("table"); const head = document.createElement("thead"); const heading = document.createElement("tr");
        for (const cell of token.header || []) { const th = document.createElement("th"); th.append(inline(cell.tokens,options)); heading.append(th); }
        head.append(heading); node.append(head);
        const body = document.createElement("tbody");
        for (const row of token.rows || []) { const tr = document.createElement("tr"); for (const cell of row) { const td = document.createElement("td"); td.append(inline(cell.tokens,options)); tr.append(td); } body.append(tr); }
        node.append(body); break;
      }
      default: node = document.createElement("p"); node.textContent = token.raw || token.text || "";
    }
    fragment.append(node);
  }
  return fragment;
}

export function renderMarkdown(root, source, options = {}) {
  const lines=String(source||'').split(/\r?\n/),body=[],notes=new Map();let fence=null;
  root._citationPrefix??='reed-source-'+crypto.randomUUID();
  for(let i=0;i<lines.length;i++){
    const line=lines[i],marker=/^ {0,3}(`{3,}|~{3,})/.exec(line);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;body.push(line);continue;}
    const definition=!fence&&/^ {0,3}\[\^([^\]\n]+)\]:[ \t]*(.*)$/.exec(line);
    if(!definition){body.push(line);continue;}
    let text=definition[2];while(i+1<lines.length&&/^(?: {2,}|\t)\S/.test(lines[i+1]))text+='\n'+lines[++i].trimStart();
    if(!notes.has(definition[1]))notes.set(definition[1],{body:text,number:notes.size+1,target:root._citationPrefix+'-'+(notes.size+1)});
  }
  const context={...options,notes,taskIndex:{value:0}};
  root.replaceChildren(blocks(marked.lexer(body.join('\n'),{gfm:true}),context));
  if(notes.size){const section=document.createElement('section');section.className='markdown-sources';section.setAttribute('aria-label','引用来源');const heading=document.createElement('h4');heading.textContent='引用来源';const list=document.createElement('ol');
    for(const note of notes.values()){const item=document.createElement('li');item.id=note.target;item.tabIndex=-1;item.append(blocks(marked.lexer(note.body,{gfm:true}),{...options,taskIndex:{value:0}}));list.append(item);}section.append(heading,list);root.append(section);}
}
