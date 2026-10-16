import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readLearningSource} from './learning-source.mjs';
test('来源行号预览读取隔离笔记并拒绝越界、非文本及无效来源',async()=>{
  const root=await mkdtemp(join(tmpdir(),'reed-source-'));try{
    const file=join(root,'test-note.md');await writeFile(file,Array.from({length:30},(_,i)=>'合成笔记第 '+(i+1)+' 行').join('\n'));
    const cap={resolveFile:async()=>file};const url='summon-file:'+encodeURIComponent(file)+'#L8';
    const source=await readLearningSource(url,cap,root);assert.equal(source.line,8);assert.equal(source.lines.find(l=>l.number===8).text,'合成笔记第 8 行');assert.equal(source.lines[0].number,2);
    await assert.rejects(readLearningSource(url.replace('#L8','#L999'),cap,root),/失效/);
    await assert.rejects(readLearningSource('https://example.com',cap,root),/来源/);
    await assert.rejects(readLearningSource(url,{resolveFile:async()=>{throw Error('文件超出允许范围');}},root),/允许范围/);
    const html=join(root,'test.html');await writeFile(html,'<script>invalid</script>');await assert.rejects(readLearningSource(url,{resolveFile:async()=>html},root),/文本笔记/);
  }finally{await rm(root,{recursive:true,force:true});}
});
