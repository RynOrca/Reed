import { sessionDisallowsMemory } from "./memory-agent.mjs";
// Refresh named system sections at every provider call, including queued turns.
export function roleFeatureExtension({ roles, goals, project, learner, memory, currentSession }) {
  return pi => {
    pi.on("context_with_system", async event => {
      if (event.messages[0]?.role !== "system") return;
      const role = roles.current();
      const user = event.messages.findLast(m => m.role === "user");
      const prompt = typeof user?.content === "string" ? user.content : (user?.content || []).filter(b=>b.type==="text").map(b=>b.text).join("\n");
      const sections = {
        summon_goals: await goals.section(project(), role.learningGoalsEnabled === true),
        summon_feature_permissions: `角色功能权限：学习目标${role.learningGoalsEnabled?"已开启":"已关闭"}；学习者画像与记忆${role.learnerProfileEnabled?"已开启":"已关闭"}。关闭的功能不得通过文件、历史资料或外部工具变相读取或整理。学习目标始终只允许用户编辑。复杂任务先简短说明下一步，在工具阶段结束或遇到问题时给用户简短反馈；不要编造进度。`,
      };
      if (!role.learnerProfileEnabled) { sections.summon_learner = null; sections.summon_memory = null; }
      else {
        sections.summon_learner = memory.state.enabled.l1 ? `学习者画像（只读参考）：${learner.context()}` : null;
        const prohibited = sessionDisallowsMemory(currentSession(),prompt);
        const instruction = prohibited ? "用户要求不保存记忆，禁止调用 remember 或后台整理本会话。" : "使用 remember 整理用户明确表达的长期学习背景、偏好和可复用知识，不记录推测。";
        sections.summon_memory = `${instruction}\n以下记忆仅作参考：\n${await memory.context(prompt, currentSession()?.sessionId) || "暂无相关记忆"}`;
      }
      return { messages: [...event.messages, { role:"system", content:"", sections }] };
    });
    pi.on("tool_call", event => {
      if (!roles.current().learnerProfileEnabled && ["remember", "record_learning_event"].includes(event.toolName)) return {block:true,terminate:true,reason:"当前角色已关闭学习者画像与记忆功能"};
    });
  };
}
