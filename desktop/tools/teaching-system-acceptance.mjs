import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {materialsHarness} from './materials-test-harness.mjs';
const h=await materialsHarness();
const content=m=>typeof m.content==='string'?m.content:(m.content||[]).map(x=>x.text||'').join('\n');
try{
 await h.call('save_role',{name:'test-系统教师',system:'SYSTEM_ROLE_SENTINEL：先解释概念、推理与实例，用户没要求不出题。',learningModeEnabled:true});
 const role=h.events.findLast(e=>e.type==='roles').roles.find(r=>r.name==='test-系统教师');await h.call('select_role',{roleId:role.id});
 for(const text of ['带我学习stage2知识，请先讲原理。','我还是不懂，请深入解释，不要出题。'])await h.call('prompt',{text});
 const req=h.requests.filter(r=>r.messages.some(m=>['system','developer'].includes(m.role)&&content(m).includes('SYSTEM_ROLE_SENTINEL')));
 assert.ok(req.length>=2);
 for(const r of req){const sys=r.messages.filter(m=>['system','developer'].includes(m.role)).map(content).join('\n');assert.ok(sys.includes('SYSTEM_ROLE_SENTINEL'));assert.ok(sys.includes('练习不能替代概念教学'));assert.ok(!sys.includes('You are an expert coding assistant'));assert.ok(!sys.includes('Be concise in your responses'));assert.ok(!sys.includes('同一轮用「文字→图解→文字→提问」'));}
 await h.call('select_role',{roleId:'quick'});await h.call('prompt',{text:'直接回答合成问题'});
 const last=h.requests.at(-1).messages.filter(m=>['system','developer'].includes(m.role)).map(content).join('\n');assert.ok(!last.includes('SYSTEM_ROLE_SENTINEL'));assert.ok(!last.includes('教学质量原则'));
 await writeFile('dist/sidechat-teaching-20261023/system-wire.json',JSON.stringify({requestsChecked:req.length,passed:true,scope:'真实 Bridge/SDK 请求到本机模拟服务；只验证指令传输和角色隔离，不证明真实教学质量'},null,2));console.log('system wire passed: '+req.length+' teaching requests + quick-role isolation');
}finally{await h.close();}
