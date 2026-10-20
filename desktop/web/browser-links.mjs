// Stop bare links at prose punctuation; explicit Markdown links stay unchanged.
export function bareUrlExtension(){return {extensions:[{
  name:'reedBareUrl',level:'inline',start:source=>source.search(/https?:\/\//i),
  tokenizer(source){
    const match=/^https?:\/\/[^\s<>`，。！？；：、（）【】「」《》]+/i.exec(source);if(!match)return;
    let text=match[0].replace(/[.,;:!?]+$/,'');
    while(text.endsWith(')')&&(text.match(/\)/g)||[]).length>(text.match(/\(/g)||[]).length)text=text.slice(0,-1);
    if(!text||!/^https?:\/\/[^/]+/i.test(text))return;
    return {type:'link',raw:text,href:text,text,tokens:[{type:'text',raw:text,text}]};
  }
}]};}
