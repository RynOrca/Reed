import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityStore} from '../agent/capabilities.mjs';
const root=await mkdtemp(join(tmpdir(),'reed-vault-bench-'));
const vault=join(root,'vault'),profile=join(root,'profile');
try {
  await mkdir(vault);await mkdir(profile);
  const count=Number(process.argv[2]||400);
  for(let i=0;i<count;i++)await writeFile(join(vault,`${i}.md`),`---\ntags: [synthetic]\n---\n# 合成笔记 ${i}\n\n${Array.from({length:12},(_,n)=>`## 主题 ${n}\n\n合成检索材料 CSS 层叠样式 示例 ${i} ${n}\n`).join('\n')}`);
  const store=new CapabilityStore(profile);store.state.vaultPath=vault;
  for(const label of ['cold','warm','repeat']){
    let maxLag=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last-10);last=now;},10);
    const start=performance.now();const hits=await store.searchNotes('CSS 层叠样式',6);const ms=performance.now()-start;
    await new Promise(resolve=>setTimeout(resolve,15));clearInterval(timer);
    console.log(JSON.stringify({label,count,hits:hits.length,ms:Math.round(ms),maxEventLoopLagMs:Math.round(maxLag),timings:store.noteScanStatus.timings}));
  }
  store.close();
}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
