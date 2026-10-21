// OpenCode requires the client's own identity and one stable ID per conversation.
export function providerHeaders(model,sessionId,headers={}) {
  let url;try{url=new URL(model?.baseUrl);}catch{return headers;}
  if(url.hostname!=='opencode.ai')return headers;
  return {...headers,'User-Agent':'Reed/0.3.9','x-opencode-session':sessionId};
}
