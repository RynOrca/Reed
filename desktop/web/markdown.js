import { marked } from "./vendor/marked.esm.js";
import {renderMath,mathExtension,emphasisExtension} from "./math.js";
marked.use(mathExtension());
marked.use(emphasisExtension());

const CODE_LANGUAGES = /^(?:python|py|python3|javascript|js|jsx|typescript|ts|tsx|json|bash|sh|shell|zsh|powershell|ps1|sql|java|c|cpp|c\+\+|cs|csharp|go|rust|rs|ruby|rb|php|kotlin|swift|yaml|yml|toml|ini|css|scss|html|xml)$/i;
const CODE_LABELS = { py: "Python", python3: "Python", js: "JavaScript", ts: "TypeScript", sh: "Shell", shell: "Shell", zsh: "Shell", ps1: "PowerShell", rs: "Rust", rb: "Ruby", cs: "C#", yml: "YAML", htm: "HTML" };
// 极简词法着色：注释、字符串、数字、关键字与函数名。只认常见语言，其它语言原样显示。
const CODE_KEYWORDS = new Set(("def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield global nonlocal assert del pass break continue async await match case self " +
  "function const let var new typeof instanceof this super extends static get set of null undefined true false => " +
  "SELECT FROM WHERE INSERT UPDATE DELETE JOIN GROUP ORDER BY LIMIT SUM COUNT AS ON AND OR NOT NULL BEGIN COMMIT " +
  "public private protected struct enum impl fn let mut use mod match trait void int char bool float double string final").split(/\s+/).filter(Boolean));
function codeSpans(code, lang) {
  const fragment = document.createDocumentFragment();
  const word = (value, cls) => { const node = document.createElement("span"); if (cls) node.className = cls; node.textContent = value; return node; };
  if (!CODE_LANGUAGES.test(String(lang || ""))) { fragment.append(document.createTextNode(code)); return fragment; }
  const pattern = new RegExp("(#[^\\n]*|//[^\\n]*)|(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b([A-Za-z_][A-Za-z0-9_]*)\\b", "g");
  let last = 0;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    // end 必须按整段匹配算：用组长度会在前导空白/注释上错位，导致后面全部落到纯文本分支。
    const end = match.index + match[0].length;
    if (match.index > last) fragment.append(document.createTextNode(code.slice(last, match.index)));
    if (match[1]) fragment.append(word(match[1], "tk-com"));
    else if (match[2]) fragment.append(word(match[2], "tk-str"));
    else if (match[3]) fragment.append(word(match[3], "tk-num"));
    else if (CODE_KEYWORDS.has(match[4])) fragment.append(word(match[4], "tk-kw"));
    else if (code[end] === "(") fragment.append(word(match[4], "tk-fn"));
    else fragment.append(document.createTextNode(match[4]));
    last = end;
  }
  if (last < code.length) fragment.append(document.createTextNode(code.slice(last)));
  return fragment;
}

// 行内 token → DOM。原始 HTML 一律按文本显示。
function inline(tokens = [], options = {}) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    let node;
    switch (token.type) {
      case "reedInlineMath": node=renderMath(token.text);break;
      case "reedEmphasis": node=document.createElement("span"); node.className="emphasis-"+token.kind; node.append(inline(token.tokens||[{type:"text",text:token.text}],options)); break;
      case "strong": node = document.createElement("strong"); node.append(inline(token.tokens,options)); break;
      case "em": node = document.createElement("em"); node.append(inline(token.tokens,options)); break;
      case "del": node = document.createElement("del"); node.append(inline(token.tokens,options)); break;
      case "codespan": node = document.createElement("code"); node.textContent = token.text; break;
      case "link": {
        const url = String(token.href || "");
        if (/^(https?:|mailto:)/i.test(url)) {
          node = document.createElement("a"); node.href = url; node.target = "_blank"; node.rel = "noopener noreferrer"; node.append(inline(token.tokens,options));
        } else if (/^(summon-file:|file:|[a-z]:[\\/]|[./\\])|\.(html?|md|txt|pdf)(#.*)?$/i.test(url) && !/^(javascript|data|vbscript):/i.test(url)) {
          node = document.createElement("a"); node.href = "#"; node.dataset.localFile = url; node.title = /\.html?(?:#.*)?$/i.test(url)?"在内置浏览器中预览":"在默认应用中打开本地文件";if(/\.html?(?:#.*)?$/i.test(url))node.className='html-preview-link';node.append(inline(token.tokens,options));
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
      case "reedBlockMath":node=renderMath(token.text,{display:true});break;
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
        node = document.createElement("div"); node.className = "markdown-code";
        const header = document.createElement("div"); header.className = "markdown-code-header";
        const language = document.createElement("span"); language.className = "markdown-code-language";
        const declared = String(token.lang || "").split(/\s+/)[0];
        language.textContent = declared ? (CODE_LABELS[declared.toLowerCase()] || declared) : "文本";
        const copy = document.createElement("button"); copy.type = "button"; copy.className = "markdown-code-copy";
        copy.textContent = "复制代码"; copy.setAttribute("aria-label", "复制代码");
        copy.onclick = async () => {
          copy.disabled = true;
          try {
            await navigator.clipboard.writeText(token.text || "");
            copy.textContent = "已复制";
          } catch {
            copy.textContent = "复制失败，请选择代码复制";
          } finally {
            copy.disabled = false;
          }
        };
        header.append(language, copy);
        const pre = document.createElement("pre"); const code = document.createElement("code");
        // 认识的语言做极简词法着色；复制仍然取原文，不带着色标签。
        code.append(codeSpans(token.text || "", declared));
        if (token.lang) code.dataset.lang = token.lang;
        pre.append(code); node.append(header, pre); break;
      }
      case "list": {
        node = document.createElement(token.ordered ? "ol" : "ul");
        if (token.ordered && token.start) node.start = token.start;
        for (const item of token.items || []) { const li = document.createElement("li"); if(item.task)li.className="task-list-item"; li.append(blocks(item.tokens,options)); node.append(li); }
        break;
      }
      case "blockquote": node = document.createElement("blockquote"); node.append(blocks(token.tokens,options)); break;
      case "hr": node = document.createElement("hr"); break;
      case "html": {
        // 原始 HTML 一律按文本显示；只有 <mark> / <u> 这两个纯视觉、无行为的标签例外，
        // 它们是模型可用的重点标记（不带事件、链接或脚本）。
        const raw = String(token.text || token.raw || "");
        const emphasis = /^<(mark|u)>([\s\S]*?)<\/\1>$/.exec(raw);
        if (emphasis) {
          node = document.createElement("span"); node.className = emphasis[1] === "mark" ? "emphasis-hl" : "emphasis-wave";
          node.textContent = emphasis[2];
          break;
        }
        node = document.createElement("p"); node.textContent = raw; break;
      }
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

// 行内富文本（含 $...$ 与 \(...\) 公式）：给流程图标签、结果值这类本来只当纯文本
// 显示的字段用，避免模型写的 LaTeX 被原样展示。这里要的是行内 token，
// 直接用 marked 的行内词法器，不能走 blocks 词法器（那会多包一层段落）。
export function renderInline(root, source, options = {}) {
  const lexer = new marked.Lexer({ ...marked.defaults, gfm: true });
  const tokens = lexer.inlineTokens(String(source ?? ""));
  root.replaceChildren(inline(tokens, { ...options, notes: options.notes || new Map(), taskIndex: { value: 0 } }));
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
  root.replaceChildren(blocks(marked.lexer(body.join('\n'),{...marked.defaults,gfm:true}),context));
  if(notes.size){const section=document.createElement('section');section.className='markdown-sources';section.setAttribute('aria-label','引用来源');const heading=document.createElement('h4');heading.textContent='引用来源';const list=document.createElement('ol');
    for(const note of notes.values()){const item=document.createElement('li');item.id=note.target;item.tabIndex=-1;item.append(blocks(marked.lexer(note.body,{...marked.defaults,gfm:true}),{...options,taskIndex:{value:0}}));list.append(item);}section.append(heading,list);root.append(section);}
}
