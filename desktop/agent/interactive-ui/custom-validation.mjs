import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Script} from 'node:vm';
import {AgentBrowser} from '../browser.mjs';
import {validateDocument} from './protocol.mjs';

export async function validateCustomRuntime(document,{Browser=AgentBrowser}={}){
  validateDocument(document);
  new Script(`'use strict';\n${document.script}`,{filename:'interactive-component.js'}); // Parse only. Never execute model code in Node.
  const directory=await mkdtemp(join(tmpdir(),'reed-custom-validation-')),browser=new Browser(directory);
  const web=new URL('../../web/',import.meta.url),allowed=new Set(['custom-sandbox.js','custom-contract.mjs','custom-frame.html','custom-frame.js']);
  const server=createServer(async(req,res)=>{try{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; frame-src \'self\'; style-src \'self\' \'unsafe-inline\'"><main id="root"></main><script type="module" src="/validate.js"></script>');return;}
    if(req.url==='/validate.js'){res.setHeader('Content-Type','text/javascript');res.end('import {createCustomExperience} from "/custom-sandbox.js"; window.validate=async doc=>{const ui=createCustomExperience(doc,doc.initialState,()=>{});document.querySelector("#root").replaceChildren(ui);const initial=await ui.ready;const checks=[];if(initial.status==="ready")for(const c of doc.checks){const reply=await ui.runAction(c.action,c.value);checks.push(reply);if(reply.status!=="ready")break;}const result={initial,checks};ui.dispose();return result;};');return;}
    const file=req.url.slice(1);if(!allowed.has(file)){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8');res.end(await readFile(new URL(file,web)));
  }catch{res.writeHead(500);res.end();}});
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await browser.start();await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
    for(let i=0;i<40;i++){if(await browser.evaluate('typeof window.validate==="function"'))break;await new Promise(r=>setTimeout(r,50));}
    const result=await browser.evaluate(`window.validate(${JSON.stringify(document)})`);
    if(result?.initial?.status!=='ready'||result.checks.length!==document.checks.length||result.checks.some(c=>c.status!=='ready'))throw new Error(`自定义作品试运行失败：${JSON.stringify(result).slice(0,1800)}`);
    return {status:'passed',checks:result.checks.length,initial:result.initial.state,snapshots:result.checks.map(c=>c.state),note:'运行与声明操作通过；教学事实待独立核对'};
  }finally{browser.close();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
