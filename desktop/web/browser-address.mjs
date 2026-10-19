// Classify paths before schemes: C:\file.html must never become a URL scheme.
export function resolveBrowserAddress(input){
  const text=String(input||'').trim();
  if(!text)throw Error('请输入网址、搜索内容或 HTML 文件路径');
  if(/[\u0000-\u001f]/.test(text))throw Error('地址含有无效字符');
  if(/^file:\/\//i.test(text)){
    const url=new URL(text);if(url.search||url.hash)throw Error('文件地址不能包含查询参数或片段');
    return {path:decodeURIComponent(url.hostname?'//'+url.hostname+url.pathname:url.pathname.replace(/^\/([a-z]:)/i,'$1'))};
  }
  if(/^[^\/\\:.]+[\/\\].*\.html?$/i.test(text)||/^(?:[a-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/[^/])/i.test(text)||(!/^[a-z][a-z\d+.-]*:|^\/\//i.test(text)&&!/[\\/]/.test(text)&&/\.html?$/i.test(text)))return {path:text};
  let target=text;
  if(/^\/\//.test(text))target='https:'+text;
  else if(!/^https?:\/\//i.test(text)){
    const local=/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(text);
    const domain=/^(?:[^\s./:@]+\.)+[^\s./:@]{2,}(?::\d+)?(?:[/?#]|$)/u.test(text);
    if(local||domain)target=(local?'http://':'https://')+text;
    else if(/^[a-z][a-z\d+.-]*:/i.test(text))throw Error('仅支持 HTTP、HTTPS 和本地 HTML 文件');
    else return {url:'https://www.bing.com/search?q='+encodeURIComponent(text)};
  }
  let url;try{url=new URL(target);}catch{throw Error('网址格式无效，请检查域名和端口');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname)throw Error('请输入不含用户名和密码的 HTTP 或 HTTPS 网址');
  return {url:url.href};
}

export function browserFailure(error){
  const detail=String(error?.message||error);
  if(/ERR_CONNECTION_CLOSED/.test(detail))return '连接被关闭（ERR_CONNECTION_CLOSED）。可重试，或检查代理和网络；不会自动降级为 HTTP。';
  if(/ERR_NAME_NOT_RESOLVED/.test(detail))return '找不到该域名，请检查拼写或 DNS 设置。';
  if(/ERR_CERT/.test(detail))return '网站证书验证失败，请检查系统时间或网站证书。';
  if(/ENOENT/.test(detail))return '找不到这个 HTML 文件，请检查路径或重新选择文件。';
  return detail;
}
