# PI 思考中断诊断计划

日期：2026-10-11。用户已确认继续排查；本阶段不修改运行代码。
基线 Git：`4cc5a8f2f2891f92f2b504fe0afe63caa7bb8fc3`。
诊断成果 Git 标签：`reed-stream-diagnosis-2026-10-11`。

## 已完成

- [x] 对照截图与实际会话记录，确认服务返回 `stopReason=length`、`rawStopReason=length`；输入 5,359、输出 10,574，其中 reasoning 10,574。没有正文或工具调用。
- [x] 追踪自定义模型默认值：`provider-composer.js` 将未配置的 `maxTokens` 补为 16,384。使用工具现有 JavaScript 运行环境离线调用 SDK `buildBaseOptions`，核算该轮上限为 16,384；没有启动项目 Node 服务或请求模型。
- [x] 确认当前模型配置声明上下文 262,144、思考格式 openai、档位 medium；没有显式输出上限或思考 token 预算字段。
- [x] 确认 SDK 对输出低于期望上限的 length 尝试恢复：先通过 context_edit 隐藏截断回复，再准备压缩；没有可压缩内容时返回 false，结束恢复。默认保留近期 20,000 tokens，本次短会话没有产生 compaction 或后续模型回复。
- [x] 确认 Reed bridge 在 prompt 返回后直接发送 done，UI 将 done/settled 都标为完成，没有 length 或无正文检查。
- [x] 核对本机 PI-Desktop-src：runtime.ts 存在 SILENT_TURN_NUDGE，检测无正文且无工具调用时自动继续一次，再次无输出则报告 EMPTY_MODEL_RESPONSE。这是本地源码行为，不能据此断言用户当前安装二进制一定相同。
- [x] 核对会话 context_edit：只隐藏截断的 assistant 回复，太阳系 user 消息仍在活动分支。SDK projection 与转换源码保留 user 消息。尚未取得下一轮实际 HTTP 请求体，不能断言服务端收到的内容，更不能声称用户任务已被删除。

## 结论与边界

未填写 maxTokens 不足以解释异常，且 SDK 实际仍有默认上限。首次 length 是模型服务报告的生成截断；现有记录不能区分服务内部输出限制、思考限制、时间限制或错误的 finish_reason。

用户看到的静默结束由两项确定问题叠加：SDK 的恢复依赖可执行的压缩，短会话没有压缩候选时不继续；Reed 未区分生成结束与成功产生结果，也没有 PI-Desktop 的无输出恢复层。

下一轮声称用户只发过 hi 属于未正确承接任务。会话没有删除该任务；实际请求、服务模板处理和模型忽略上下文的可能性仍需验证。

## 后续计划（待确认实施）

- [ ] 在隔离测试中模拟 thinking-only + length，验证短会话恢复失败路径与用户消息保留。
- [ ] 修复 bridge 结束分类和 UI 截断提示；恢复阶段不提前显示完成。
- [ ] 增加一次有界无输出恢复，保留原用户任务；再次失败明确报告可重试错误。
- [ ] 增加不记录凭据的请求诊断：有效输出上限、思考字段、用户消息数量与长度、结束原因及用量。默认不记录完整对话正文。
- [ ] 在用户确认的隔离会话抓取一次真实服务请求/结束事件，与 pi-desktop 同模型同任务比较；确定服务为何提前返回 length。
- [ ] 实施前按用户要求确认同项目已运行 Node 进程如何处理；不得关闭用户程序或启动重复服务。

未修改用户数据、提供商设置、依赖或运行中的 Reed。已有 PLAN.md 未提交修改保持原样，不纳入本次提交。

## 2026-10-11 参数语义与其他 harness 对照

- SDK 的 maxTokens 是内部通用字段，不等于 HTTP max_tokens。当前自定义服务未匹配特殊提供商规则，也未覆盖 maxTokensField，适配器代码路径会发送 max_completion_tokens=16384；这是配置和源码推导，尚非历史请求抓包。
- OpenAI 官方 token-counting 文档：max_completion_tokens / max_output_tokens 包含不可见推理 token。
- 百炼 OpenAI Chat 文档：Qwen 的 max_tokens 通常只限制回答，max_completion_tokens 限制思考和回答之和。自定义 Qwen 部署是否遵循该契约仍未知，不能仅凭模型名称套用百炼规则。
- 思考预算和总输出上限必须按提供商分别映射。百炼 Qwen3.8 的 reasoning_effort 与 thinking_budget 不允许同时设置；不能盲目给已有 effort 请求追加 budget。
- Codex 源码版本 806d9732c974bc8a51b8317c1bd8985544fe627c：codex-api/src/sse/responses.rs 将非 interrupted 的 response.incomplete（包括 max_output_tokens）作为流式错误；interrupted 保留 end_turn=false。此证据只支持正确分类，不代表所有截断都能自动恢复。
- DSH 版本 d743267388641bc76f17c45ce8b4c231aed1d32c：agent-loop 将 max-tokens 作为独立且不可降级的 turn outcome；请求失败由 agent/request-error 和 llm-retry 插件处理。所查核心代码没有思考耗尽自动降档的分支。
- Hermes 版本 f86276d2ebcccf0530873c11e2965c3f1cbd5a31：turn_truncation.py 对正文为空、独立字段思考截断的续写设置一次性 reasoning-off；避免空 assistant 片段，设置续写上限并清理续写提示。若正文含未结束的 think 标签则直接报告思考预算耗尽；重复生成或上下文满也有独立终止条件。不是对所有 length 一律重试。
- 建议修复顺序：记录实际参数并确定服务契约；区分正常完成/截断/错误/停止；针对无正文进行一次改变参数的有界恢复，且不依赖压缩候选；工具参数被截断时不执行；恢复失败给出可重试状态。

一手来源：
- https://developers.openai.com/api/docs/guides/token-counting
- https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/codex-api/src/sse/responses.rs
- https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts
- https://github.com/NousResearch/hermes-agent/blob/f86276d2ebcccf0530873c11e2965c3f1cbd5a31/agent/turn_truncation.py
