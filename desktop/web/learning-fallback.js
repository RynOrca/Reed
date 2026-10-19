// Both live completion and history replay use this fallback. Internal tool
// diagnostics stay available without filling the assistant's main text.
export function renderLearningFailure(root,{fallback='',content=[]}={}) {
  const message=document.createElement('p');
  message.textContent=typeof fallback==='string'&&fallback.trim()?fallback.slice(0,6000):'图解暂时无法显示，请继续阅读正文。';
  root.replaceChildren(message);
  const diagnostics=Array.isArray(content)?content.filter(block=>block?.type==='text').map(block=>block.text||'').join('\n'):'';
  if(!diagnostics)return;
  const details=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('pre');
  summary.textContent='图解未生成 · 查看诊断';
  text.textContent=diagnostics.slice(0,12000);
  text.style.whiteSpace='pre-wrap';text.style.overflowWrap='anywhere';
  details.append(summary,text);root.append(details);
}
