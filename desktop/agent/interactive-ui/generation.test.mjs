import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInteractiveGeneration, INTERACTIVE_TOOL } from './generation.mjs';
import { InteractiveArtifactStore, boundArtifactIds } from './artifacts.mjs';
import { createFixedDocument } from './fixtures.mjs';
import { validateDocument } from './protocol.mjs';

test('内置 Skill 的五份完整 few-shot 均符合当前组件协议', async () => {
  const text=await readFile(new URL('../skills/interactive-explanation/SKILL.md',import.meta.url),'utf8');
  const samples=[...text.matchAll(/```json\s*([\s\S]*?)```/g)].map(match=>JSON.parse(match[1]));
  assert.equal(samples.length,5);
  for(const sample of samples) assert.equal(validateDocument(sample),sample);
  assert.ok(samples.some(s=>s.nodes?.some(n=>n.type==='StringTracks')));
  assert.ok(samples.some(s=>s.nodes?.some(n=>n.type==='DragHandle')));
});

test('生成工具权限、Skill 注入、格式反馈、消息绑定和父版本分支隔离', async () => {
  const root = await mkdtemp(join(tmpdir(),'reed-generation-'));
  try {
    const role={interactiveUiEnabled:false}, events=[], hooks={}, tools=[];
    const branch=[{id:'assistant-owner',type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'call',name:INTERACTIVE_TOOL}]}}];
    const session={sessionId:randomUUID(),sessionManager:{getBranch:()=>branch,appendCustomEntry:(customType,data)=>branch.push({type:'custom',customType,data})}};
    const store=new InteractiveArtifactStore(root);
    const generator=await createInteractiveGeneration({roles:{current:()=>role},currentSession:()=>session,store,send:e=>events.push(e)});
    const pi={on:(name,fn)=>hooks[name]=fn,registerTool:tool=>tools.push(tool)};
    generator.extension(pi);
    assert.equal(tools.length,0);
    assert.equal(hooks.context_with_system({messages:[{role:'system'}]}).messages.at(-1).sections.reed_interactive_skill,null);
    assert.equal(hooks.tool_call({toolName:INTERACTIVE_TOOL}).block,true);
    role.interactiveUiEnabled=true;generator.extension(pi);
    assert.equal(tools.length,1);
    assert.match(hooks.context_with_system({messages:[{role:'system'}]}).messages.at(-1).sections.reed_interactive_skill,/valuesByState/);
    const tool=tools[0], document=JSON.stringify(createFixedDocument('attention'));
    await assert.rejects(tool.execute('call',{document:'broken'}),/合法 JSON/);
    await assert.rejects(tool.execute('call',{document:JSON.stringify({schemaVersion:1,mode:'components',title:'bad'})}),/格式无效/);
    await assert.rejects(tool.execute('missing',{document}),/助手消息/);
    await tool.execute('call',{document});
    const id=events.at(-1).summary.artifactId;
    assert.ok(boundArtifactIds(branch).has(id));
    assert.equal((await store.read(session.sessionId,id)).document.title,createFixedDocument('attention').title);
    await tool.execute('call',{document,parentArtifactId:id});
    assert.equal((await store.read(session.sessionId,events.at(-1).summary.artifactId)).parentArtifactId,id);
    branch.splice(1);
    await assert.rejects(tool.execute('call',{document,parentArtifactId:id}),/当前会话分支/);
    role.interactiveUiEnabled=false;
    await assert.rejects(tool.execute('call',{document}),/未启用/);
  } finally {await rm(root,{recursive:true,force:true});}
});
