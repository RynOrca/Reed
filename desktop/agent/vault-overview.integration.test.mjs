// End-to-end check of the vault overview against a real bridge process and a local
// mock endpoint: with the provider's experimental parallel setting the batches must
// overlap, without it the run must stay strictly sequential. Synthetic notes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const parallel of [false, true]) {
  test(`总览批次按提供商并行设置${parallel ? '并发' : '串行'}请求模型服务`, {timeout:60000}, async () => {
    const root = await mkdtemp(join(tmpdir(),'reed-overview-parallel-')), data = join(root,'profile'), vault = join(root,'vault');
    let child, seq = 0;
    let active = 0, peak = 0, requests = 0;
    const seen = [], waiters = new Set();
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      requests++; active++; peak = Math.max(peak, active);
      res.on('close', () => { active--; });
      res.writeHead(200, {'content-type':'text/event-stream'}); res.flushHeaders();
      await delay(150);
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'## 批次摘要 / 总览正文'},finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
    const until = (predicate, ms = 30000) => { const prior = seen.find(predicate); if (prior) return Promise.resolve(prior); return new Promise((resolve, reject) => { const item = {predicate, resolve}; item.timer = setTimeout(() => { waiters.delete(item); reject(Error('fixture event timeout')); }, ms); waiters.add(item); }); };
    const send = (type, args = {}) => { const id = String(++seq); child.stdin.write(JSON.stringify({id,type,...args})+'\n'); return id; };
    const command = async (type, args = {}) => { const id = send(type,args); const result = await until(e => e.id === id && ['ack','done','error'].includes(e.type)); if (result.type === 'error') throw Error(result.message); return result; };
    try {
      await Promise.all([mkdir(data), mkdir(vault)]);
      for (let i = 0; i < 6; i++) await writeFile(join(vault,`note-${i}.md`), `# 合成笔记 ${i}\n\n${'矩阵特征值 层叠样式 合成内容'.repeat(200)}`);
      await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
      const provider = {id:'synthetic',template:'custom',name:'mock',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,protocol:'openai-completions',parallelRequests:parallel,maxConcurrentRequests:2,models:[{id:'mock',contextWindow:65536,maxTokens:2048,reasoning:false}]};
      await writeFile(join(data,'user-config.json'), JSON.stringify({version:1,providers:{providers:[provider]},memoryEnabled:{l1:false,l2:false,l3:false,work:false},capabilities:{vaultPath:vault,skills:[],webEnabled:false,browserEnabled:false}}));
      await writeFile(join(data,'app-state.json'), JSON.stringify({provider:provider.id,modelId:'mock',projectPath:root}));
      child = spawn(process.execPath,[fileURLToPath(new URL('./bridge.mjs',import.meta.url))],{cwd:root,windowsHide:true,env:{...process.env,SUMMON_DATA_DIR:data,SUMMON_WORKSPACE:root},stdio:['pipe','pipe','pipe']});
      child.stderr.resume();
      createInterface({input:child.stdout}).on('line', line => { let event; try { event = JSON.parse(line); } catch { return; } seen.push(event); for (const item of [...waiters]) if (item.predicate(event)) { waiters.delete(item); clearTimeout(item.timer); item.resolve(event); } });
      await until(e => e.type === 'ready');
      await command('init');
      const stopped = command('generate_vault_overview',{providerId:provider.id,modelId:'mock',reasoning:'off'});
      const generating = await until(e => e.type === 'vault_overview' && e.state === 'generating');
      assert.equal(generating.batches,3,'六篇合成笔记应分成三批');
      assert.equal(generating.concurrency,parallel?2:1);
      await stopped;
      const ready = await until(e => e.type === 'vault_overview' && e.state === 'ready', 40000);
      assert.equal(ready.failed,0);
      assert.equal(ready.concurrency,parallel?2:1);
      assert.equal(requests,4,'三批摘要加一次最终汇总');
      assert.equal(peak,parallel?2:1,parallel?'开启并行时必须同时请求两个批次':'未开启并行时必须逐批串行');
      const written = await readFile(join(vault,'Reed-笔记库总览.md'),'utf8');
      assert.match(written,/生成模型：synthetic\/mock/);
      if (parallel) assert.match(written,/批次理解并发：2/); else assert.doesNotMatch(written,/批次理解并发/);
    } finally {
      for (const item of waiters) clearTimeout(item.timer);
      child?.stdin.end();
      if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit',resolve)); await Promise.race([exited,delay(1500)]); if (child.exitCode === null) { child.kill(); await exited; } }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
  });
}
