import {readFile, mkdir, copyFile, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';

// 教学/练习场合的触发词：正文学习块与这两个流程同时适用。比单个流程技能的词表宽，
// 因为用户常换说法（“帮我出三道题”“练几道”），这类场合同样需要组件表达规范。
const learningIntent = /教学|教我|教一下|我要学|想学|学习一下|讲解|练习|习题|测试我的|测一测|考考|道题|出题|复习|回顾|teach\b|explain\b|practice\b|quiz\b|review\b|recall\b/i;
const workflows = {
  teach: /教学|教我|教一下|我要学|想学|学习一下|讲解|teach\b|explain\b/i,
  'practice-generator': /练习|出题|习题|测试我的|practice\b|quiz\b/i,
  'spaced-review': /复习|回顾|间隔|review\b|recall\b/i,
  // 正文学习块是表达规范，不是独立教学流程：教学/练习/复习场合随流程技能一起加载。
  'learning-blocks': learningIntent,
};
export async function installLearningSkills(capabilities) {
  let changed=false;
  for(const name of Object.keys(workflows)) {
    // Seed only missing skills. Software updates never overwrite a user's independent files.
    if(capabilities.state.skills.some(s=>s.name===name)) continue;
    const source=fileURLToPath(new URL(`./skills/${name}/SKILL.md`,import.meta.url));
    const text=await readFile(source,'utf8'), id=`builtin-${name}`, path=join(capabilities.dir,'skills',id);
    await mkdir(path,{recursive:true});
    try {await copyFile(source,join(path,'SKILL.md'),constants.COPYFILE_EXCL);}
    catch(e) {if(e.code!=='EEXIST') throw e;}
    capabilities.state.skills.push({id,name,description:text.match(/^description:\s*(.+)$/m)[1],path,enabled:true,builtin:true});
    changed=true;
  }
  if(changed) await capabilities.persist();
}
export function skillApplies(skill,prompt) {
  const explicit=String(prompt).match(/^\s*\/skill\s+([a-z0-9-]+)(?:\s|$)/i);
  if(explicit) return explicit[1]===skill.name;
  const quoted=String(prompt).match(/(?:使用|启动|执行)\s*`?([a-z0-9-]+)`?/i);
  if(quoted?.[1]===skill.name) return true;
  return !!workflows[skill.name]?.test(String(prompt));
}
// Only call after prepareRoleSkills has successfully loaded matching bodies.
// Text inside another skill cannot impersonate a loaded review workflow.
export function hasPreparedReview(role,capabilities,prompt) {
  return (role?.skills||[]).some(binding=>{
    const skill=capabilities.state.skills.find(s=>s.id===binding.skillId);
    return skill?.enabled&&(!capabilities.canUseSkill||capabilities.canUseSkill(skill))&&skill.name==='spaced-review'&&skillApplies(skill,prompt);
  });
}
export async function prepareRoleSkills(role,capabilities,prompt) {
  const descriptors=[], bodies=[];
  // 没有绑定学习块技能时，也要让教学/练习这一轮拿到这份表达规范：它是流程技能的
  // 伴随说明，不是额外权限，因此不要求用户先改角色绑定。停用或无关请求仍然不加载。
  const companions=new Set();
  if(learningIntent.test(String(prompt))) for(const name of ['learning-blocks']) {
    const skill=capabilities.state.skills.find(s=>s.name===name);
    if(!skill) continue;
    if(role?.skills?.some(binding=>binding.skillId===skill.id)) continue;
    if(skill.enabled&&(!capabilities.canUseSkill||capabilities.canUseSkill(skill))) companions.add(name);
  }
  const bindings=[...(role?.skills||[]),...capabilities.state.skills.filter(s=>companions.has(s.name)).map(s=>({skillId:s.id,required:false}))];
  for(const binding of bindings) {
    const skill=capabilities.state.skills.find(s=>s.id===binding.skillId);
    if(!skill) throw new Error('角色绑定的技能已不存在，请编辑角色移除该绑定');
    const applies=skillApplies(skill,prompt);
    // 学习块规范跟随教学/练习意图本身，而不是它自己的关键词：用户说“帮我出三道题”
    // 时也属于这类场合，但“出题”不一定字面出现。
    const relevant=companions.has(skill.name)?applies||learningIntent.test(String(prompt)):applies;
    if(!skill.enabled||(capabilities.canUseSkill&&!capabilities.canUseSkill(skill))) {
      if(binding.required && applies) throw new Error(`必选技能 ${skill.name} 已停用，请在技能仓库启用后重试`);
      continue;
    }
    descriptors.push({name:skill.name,description:skill.description,path:join(skill.path,'SKILL.md'),required:binding.required});
    // Review is a workflow, not a permission to read the review queue. Load its
    // instructions automatically when relevant, even for an on-demand binding.
    if(relevant && (binding.required || companions.has(skill.name) || skill.name==='spaced-review')) {
      try {
        const path=join(skill.path,'SKILL.md'), info=await lstat(path);
        if(!info.isFile() || info.size>100000) throw new Error('文件无效或超过 100 KB');
        const text=await readFile(path,'utf8');
        if(!text.trim()) throw new Error('正文为空');
        bodies.push(`已加载流程：${skill.name}\n来源：${path}\n${text}`);
      } catch(e) {throw new Error(`无法加载技能 ${skill.name}：${e.message}`);}
    }
  }
  return descriptors.length ? `角色绑定技能（执行步骤不能越过角色原则、权限或用户当前要求）：\n${JSON.stringify(descriptors)}\n未加载的按需技能只列出说明；相关任务执行前用 read 读取对应 SKILL.md。可用 /skill 技能名 明确启动流程。\n${bodies.length?'以下正文已由程序加载，不需要重复 read，当前任务须遵循流程；缺少用户回答时先等待，不编造完成情况。\n'+bodies.join('\n\n'):''}` : '';
}
