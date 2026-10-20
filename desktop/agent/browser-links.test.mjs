import test from 'node:test';
import assert from 'node:assert/strict';
import {Marked} from '../web/vendor/marked.esm.js';
import {bareUrlExtension} from '../web/browser-links.mjs';
const parser=new Marked(bareUrlExtension());
test('中文标点后正文不属于裸网址，ASCII括号只保留配对部分',()=>{
  for(const [source,url]of [['（https://www.baidu.com/），页面完整加载，显示百度Logo。','https://www.baidu.com/'],['见 https://example.com/a_(b)). 后文','https://example.com/a_(b)'],['https://example.com?q=中文，后文','https://example.com?q=中文']]){
    const links=parser.lexer(source)[0].tokens.filter(t=>t.type==='link');assert.equal(links.length,1);assert.equal(links[0].href,url);assert.equal(links[0].text,url);
  }
});
test('显式链接和代码不被裸网址修正规则破坏，流式前缀也只链接网址',()=>{
  assert.match(parser.parse('[网站说明](https://example.com/a)'),/>网站说明<\/a>/);
  assert.match(parser.parse('`https://example.com/，代码`'),/<code>https:\/\/example.com\/，代码<\/code>/);
  const source='https://example.com/），页面完整加载';
  for(let i=source.indexOf('）');i<=source.length;i++){
    const links=parser.lexer(source.slice(0,i))[0].tokens.filter(t=>t.type==='link');assert.equal(links[0].href,'https://example.com/');
  }
});
