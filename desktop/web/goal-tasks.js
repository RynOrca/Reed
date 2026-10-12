import { marked } from "./vendor/marked.esm.js";

// Follow parsed block order so task-like text in code blocks is never counted.
export function goalTasks(source) {
  const tasks=[];let cursor=0;
  function visit(tokens) {
    for(const token of tokens) {
      if(token.type==="code" || token.type==="html") {const start=source.indexOf(token.raw,cursor);if(start>=0)cursor=start+token.raw.length;}
      if(token.type==="list") for(const item of token.items) {
        if(item.task) {
          const line=item.raw.split(/\r?\n/)[0];const start=source.indexOf(line,cursor);
          const marker=line.match(/\[([ xX])\]/);
          if(start>=0 && marker) {const offset=start+marker.index+1;tasks.push({offset,checked:item.checked});cursor=offset+1;}
        }
        visit(item.tokens || []);
      }
      else if(token.type==="blockquote")visit(token.tokens);
    }
  }
  visit(marked.lexer(source,{gfm:true}));return tasks;
}
