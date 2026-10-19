import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBrowserAddress,browserFailure} from '../web/browser-address.mjs';

test('地址栏补全协议并保留显式协议、端口、路径、查询和片段',()=>{
  for(const [input,url] of [
    ['baidu.com','https://baidu.com/'],['www.example.com/a?q=中#b','https://www.example.com/a?q=%E4%B8%AD#b'],
    ['http://example.com','http://example.com/'],['https://example.com/page.html','https://example.com/page.html'],
    ['example.com/page.html','https://example.com/page.html'],['localhost:8080/page','http://localhost:8080/page'],
    ['127.0.0.1:3000','http://127.0.0.1:3000/'],['192.168.1.2','http://192.168.1.2/'],
    ['[::1]:8080','http://[::1]:8080/'],['//example.com','https://example.com/'],
    ['例子.测试','https://xn--fsqu00a.xn--0zwm56d/'],
  ])assert.deepEqual(resolveBrowserAddress(input),{url},input);
});
test('文件和普通文本不会误走本地域名流程',()=>{
  for(const path of ['C:/notes/page.html','D:\\notes\\page.html','./page.html','../page.htm','folder/page.html','page.html'])assert.deepEqual(resolveBrowserAddress(path),{path});
  assert.deepEqual(resolveBrowserAddress('file:///C:/my%20notes/page.html'),{path:'C:/my notes/page.html'});
  assert.deepEqual(resolveBrowserAddress('怎样学习 Rust'),{url:'https://www.bing.com/search?q='+encodeURIComponent('怎样学习 Rust')});
});
test('危险协议、凭据、无效端口和空输入给出错误，不读取文件或降级HTTPS',()=>{
  for(const text of ['','javascript:alert(1)','data:text/html,test','ftp://example.com','https://user:pass@example.com','https://example.com:99999'])assert.throws(()=>resolveBrowserAddress(text),undefined,text);
  assert.match(browserFailure(Error('net::ERR_CONNECTION_CLOSED')),/不会自动降级/);
});
