import { readFile } from 'node:fs/promises';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { boundArtifactIds } from './artifacts.mjs';

export const INTERACTIVE_TOOL = 'generate_learning_ui';
export async function createInteractiveGeneration({ roles, currentSession, store, send }) {
  const skill = await readFile(new URL('../skills/interactive-explanation/SKILL.md', import.meta.url), 'utf8');
  const extension = pi => {
    pi.on('context_with_system', event => {
      if (event.messages[0]?.role !== 'system') return;
      return { messages: [...event.messages, { role: 'system', content: '', sections: {
        reed_interactive_skill: roles.current().interactiveUiEnabled === true ? skill : null,
      } }] };
    });
    pi.on('tool_call', event => {
      if (event.toolName === INTERACTIVE_TOOL && roles.current().interactiveUiEnabled !== true)
        return { block: true, terminate: true, reason: '当前角色未启用交互讲解' };
    });
    // A disabled role does not even register the tool; execution checks remain as a second gate.
    if (roles.current().interactiveUiEnabled !== true) return;
    pi.registerTool(defineTool({
      name: INTERACTIVE_TOOL, label: '生成交互讲解',
      description: '按内置 interactive-explanation Skill 生成原生交互卡片。document 是组件协议 JSON 字符串，不是 HTML。格式错误会返回原因，修正后重试；不代表教学事实已核验。',
      parameters: Type.Object({ document: Type.String({ maxLength: 32768 }), parentArtifactId: Type.Optional(Type.String()) }),
      async execute(toolCallId, input) {
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
        if (!['components','algorithm','math'].includes(document?.mode)) throw new Error('模型生成仅支持 components、algorithm 或 math 模式');
        const artifact = await store.create(session.sessionId, document, { parentArtifactId: input.parentArtifactId || null });
        session.sessionManager.appendCustomEntry('reed_interactive_artifact', { messageEntryId: owner.id, artifactId: artifact.artifactId });
        const summary = await store.summary(session.sessionId, artifact.artifactId);
        send({ type: 'interactive_artifact', sessionId: session.sessionId, summary });
        return { content: [{ type: 'text', text: JSON.stringify({ artifactId: artifact.artifactId, title: document.title, status: 'created', note: '卡片已展示。格式校验通过，教学事实仍需核验。' }) }], details: { artifactId: artifact.artifactId } };
      },
    }));
  };
  return { extension };
}
