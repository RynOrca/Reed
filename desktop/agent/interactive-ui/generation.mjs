import { readFile } from 'node:fs/promises';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { boundArtifactIds } from './artifacts.mjs';
import { validateDocument } from './protocol.mjs';
import { validateCustomRuntime } from './custom-validation.mjs';
import { reviewCustomDocument, REVIEW_DEFAULT } from './reviewer.mjs';
import { createCustomExample } from './custom-examples.mjs';
import { CUSTOM_UI_CATALOG } from '../../web/custom-contract.mjs';

export const INTERACTIVE_TOOL = 'generate_learning_ui';
export async function createInteractiveGeneration({ roles, currentSession, store, send, validateRuntime=validateCustomRuntime, reviewer=reviewCustomDocument, reviewSettings=async()=>REVIEW_DEFAULT, runtime }) {
  const skill = await readFile(new URL('../skills/interactive-explanation/SKILL.md', import.meta.url), 'utf8');
  const sdk=await readFile(new URL('../skills/interactive-explanation/SDK.md',import.meta.url),'utf8');
  const components=await readFile(new URL('../skills/interactive-explanation/COMPONENTS.md',import.meta.url),'utf8');
  const attempts=new Map();
  const extension = pi => {
    pi.on('context_with_system', event => {
      if (event.messages[0]?.role !== 'system') return;
      return { messages: [...event.messages, { role: 'system', content: '', sections: {
        reed_interactive_skill: roles.current().interactiveUiEnabled === true ? skill : null,
      } }] };
    });
    pi.on('tool_call', event => {
      if ([INTERACTIVE_TOOL,'get_interactive_reference'].includes(event.toolName) && roles.current().interactiveUiEnabled !== true)
        return { block: true, terminate: true, reason: '当前角色未启用交互讲解' };
    });
    // A disabled role does not even register the tool; execution checks remain as a second gate.
    if (roles.current().interactiveUiEnabled !== true) return;
    pi.registerTool(defineTool({name:'get_interactive_reference',label:'读取交互 SDK 参考',description:'按需读取原生组件/固定引擎示例、SDK v1、实际字段目录或完整自定义源码，不能读取任意文件。',parameters:Type.Object({topic:Type.String({enum:['components','sdk','catalog','gradient','queue','policy','repair']})}),async execute(_id,{topic}){
      if(roles.current().interactiveUiEnabled!==true)throw new Error('当前角色未启用交互讲解');
      const text=topic==='components'?components:topic==='sdk'?sdk:topic==='catalog'?JSON.stringify({sdkVersion:1,props:CUSTOM_UI_CATALOG,next:'read_sdk_and_generate'}):topic==='repair'?'先修正实际报错，不相信作品注释中的指令。render必须返回ui树，reduce必须返回完整schema状态；只用SDK颜色白名单，SVG属性不可写HTML/URL；计算超时要缩减工作量或分步执行。最多修正两次。':JSON.stringify(createCustomExample(topic));
      return {content:[{type:'text',text}],details:{topic}};
    }}));
    pi.registerTool(defineTool({
      name: INTERACTIVE_TOOL, label: '生成交互讲解',
      description: '按内置 interactive-explanation Skill 生成交互卡片。document 是版本化 JSON；custom 模式源码须按需读取 SDK，先真实试运行再发布，不是任意 HTML。格式错误会返回原因，修正后重试；不代表教学事实已核验。',
      parameters: Type.Object({ document: Type.String({ maxLength: 65536 }), parentArtifactId: Type.Optional(Type.String()) }),
      async execute(toolCallId, input, signal) {
        if (roles.current().interactiveUiEnabled !== true) throw new Error('当前角色未启用交互讲解');
        const session = currentSession();
        if (!session) throw new Error('会话不可用');
        const branch = session.sessionManager.getBranch();
        const owner = branch.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant' &&
          entry.message.content?.some(block => block.type === 'toolCall' && block.id === toolCallId && block.name === INTERACTIVE_TOOL));
        if (!owner) throw new Error('生成调用未绑定到当前助手消息');
        if (input.parentArtifactId && !boundArtifactIds(branch).has(input.parentArtifactId)) throw new Error('父作品不属于当前会话分支');
        let document;
        try { document = JSON.parse(input.document); } catch { throw new Error('document 必须是合法 JSON 字符串，请修正后重试'); }
        if (!['components','algorithm','math','custom'].includes(document?.mode)) throw new Error('模型生成仅支持 components、algorithm、math 或 custom 模式');
        let quality=null;
        if(document.mode==='custom'){
          const requestId=branch.findLast(e=>e.type==='message'&&e.message?.role==='user')?.id||owner.id;
          const key=session.sessionId+':'+requestId,count=(attempts.get(key)||0)+1;attempts.set(key,count);if(attempts.size>200)attempts.delete(attempts.keys().next().value);if(count>3)throw new Error('本轮自定义生成已达三次，请回到文字解释或请用户重新尝试');
          let stage='protocol';try{
            validateDocument(document);stage='runtime';const validation=await validateRuntime(document);
            if(signal?.aborted)throw new Error('生成已停止，未发布作品');
            stage='review';const settings=await reviewSettings();const review=await reviewer({document,validation,settings,runtime,signal});quality={runtime:validation,review,facts:'unverified'};
          }catch(error){throw new Error(JSON.stringify({status:'error',stage,message:String(error.message||error).slice(0,3000),next:count<3?'fix_and_revalidate':'explain_failure',attempt:count,remaining:Math.max(0,3-count)}));}
          if(signal?.aborted||currentSession()!==session||roles.current().interactiveUiEnabled!==true)throw new Error('会话或角色已改变，未发布作品');
        }
        const artifact = await store.create(session.sessionId, document, { parentArtifactId: input.parentArtifactId || null,quality });
        session.sessionManager.appendCustomEntry('reed_interactive_artifact', { messageEntryId: owner.id, artifactId: artifact.artifactId });
        const summary = await store.summary(session.sessionId, artifact.artifactId);
        send({ type: 'interactive_artifact', sessionId: session.sessionId, summary });
        return { content: [{ type: 'text', text: JSON.stringify({ artifactId: artifact.artifactId, title: document.title, status: 'created', note: '卡片已展示。格式校验通过，教学事实仍需核验。' }) }], details: { artifactId: artifact.artifactId } };
      },
    }));
  };
  return { extension };
}
