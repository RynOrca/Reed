# 个人笔记检索验收方案与结果

日期：2026-10-13

## 验收范围

运行 `desktop/tools/knowledge-stage-acceptance.mjs`，在系统临时目录创建合成 Vault 和独立 SQLite 索引，并在结束时清理。它不读取或修改用户的 Vault、应用配置或记忆。扩词模型由确定性 mock 提供，模拟结果与真实模型验收分开记录。

固定查询覆盖中文精确标题、英文同义词召回中文笔记和弱命中扩词。三项均验证预期文件、固定证据短语所在行，以及引用起止行和 `#L` 链接。状态刷新覆盖正文编辑、文件重命名、删除、权限拒绝后权限恢复、部分扫描中隐藏已缩短文件的旧尾段，以及 Vault 不可达。

规模基线创建 200 篇合成笔记，每篇 1 个标题和 3 个正文段落。报告冷扫描并检索的总耗时、5 次热查询样本及中位数、索引段数。该数据用于记录当前机器量级，不设置未经实测的通过阈值，也不外推到用户真实笔记库。

## 运行预算

单次运行需要 Node.js 内置 SQLite 支持；预计写入和读取 200 个小型临时 Markdown 文件，顺序扫描最多约 208 篇合成笔记，并进行 5 次热查询。无模型调用、无网络请求。运行期间内存和磁盘数据只在操作系统临时目录中，脚本 `finally` 会清理目录。按串行运行，预留 1 分钟；如超时则保留终端输出并报告，不追加全量测试或构建。

从仓库根目录运行：

```powershell
node desktop/tools/knowledge-stage-acceptance.mjs
```

## 模拟规划器与合成 Vault 结果

2026-10-13，`node desktop/tools/knowledge-stage-acceptance.mjs` 一次通过，全部断言为 true。三条固定查询引用的预期证据都落在第 3 行；编辑、重命名、删除、拒绝权限后的旧索引隐藏、恢复权限后重新召回、部分扫描旧尾段隔离和 Vault 不可达检查均通过。

200 篇合成笔记（每篇 3 个正文段落）索引 812 段。冷扫描加查询耗时 773.86 ms；5 次热查询为 205.74、167.87、208.24、185.44、144.61 ms，中位数 185.44 ms。这个数据只测当前机器上的本地扫描和索引路径，不包含模型规划，不代表实际用户笔记规模。

精确标题和弱命中各返回 5 项，其中按合成路径标签标注的相关项为 2 项（0.4）；这是明显的合成检索噪声信号，应结合人工标注的真实笔记查询再决定是否调排名。英文同义词案例返回 1 项且目标文件命中。模拟规划器的扩词调用数不代表真实模型行为或费用。

## 真实模型 notes-only 结果

真实验收命令只执行了一次成功调用，使用 `qwen3.8-27b-long`、low thinking。系统默认沙箱下首次启动返回 `spawn EPERM`；按时段授权直接用提升权限启动后完成，进程退出码为 0，临时 Vault 已清理。原始报告保存在 `dist/real-memory-acceptance/notes-current-final.json`。整个用例耗时 50,786 ms，5 次上游请求均为 HTTP 200：2 次 `note_expand`、3 次 agent 请求。

用户问题用英文提问绘图顺序、高亮颜色和验证短语。Agent 调用了 `search_notes`，并读取 `特征分解.md` 原文；回答分别为“先画两支定向杆再标伸缩倍率”、紫色、“青铜海燕”。逐字引用和链接指向原文第 3 行，报告中的 `usedSearchTool`、三项答案字段、`hasSourceCitation`、`hasVerbatimEvidence` 均为 true。模型最后用中文作答，但内容正确，引用段落支持三个答案。

真实 `note_expand` 的两次 helper 输出都为空，结束原因为 `length`，且 `captureTruncated` 为 false；分别消耗 463 和 406 tokens（completion 均 240 reasoning tokens）。这表明规划器未在本次预算内产出可用扩词 JSON。Agent 仍通过自身的多语种推理将问题转成中文检索词，成功找到笔记，因此本次通过证明了端到端跨语言召回与引用，不证明 `note_expand` 工作正常。真实端到端用时约 50.8 秒，绝大部分来自模型调用，不能与上面的 0.77 秒冷本地扫描或 0.19 秒热查询中位数直接比较。

真实模型只覆盖一个合成笔记用例；不能据此估计真实用户笔记库的召回率，也没有测量回答引用之外的题型或更大笔记库。模拟结果与真实模型结果应保持分开统计。

## 规划器预算修复复验

针对上述真实 `note_expand` 空输出，规划器单次输出上限从 240 提高到 1,024 tokens（上限约为原来的 4.27 倍），单次超时从 8 秒提高到 12 秒（增加 4 秒、50%）。仍保留 `reasoning: 'off'`、非精确命中门槛、最多 3 个查询、原缓存、取消信号及失败后回退；不自动重试。上限增加不等于实际消耗必然增加到 1,024 tokens；实际调用延迟与 usage 需看下一次真实原始报告。

局部测试 `node --test desktop/agent/knowledge-retrieval.test.mjs` 已通过 8/8。默认沙箱中 Node test runner 子进程遇到 `spawn EPERM`，提升权限后同一测试文件通过。

真实复验只运行一次，原始报告为 `dist/real-memory-acceptance/notes-planner-fixed.json`。使用相同 low thinking 与 notes-only 问题，5 次上游请求均 HTTP 200，端到端用时 64,165 ms。规划器表现为**一次超时、一次按时有效**：第一次 raw `helperOutput` 虽然最终是包含 3 个字符串查询的有效 JSON，finish reason 为 `stop`、`captureTruncated=false`，但上游返回用时 15,002 ms，超过产品 12 秒 deadline；该迟到结果没有被产品消费。Agent 请求在用例起始后 11,696 ms 已启动，当时 system 中没有相关笔记原文。不能把第一次迟到 JSON 算作产品成功扩词。

第二次 helper 于用例起始后 28,989 ms 开始，耗时 10,572 ms，在 deadline 内返回有效 JSON `{"queries":["特征向量","绘图约定","高亮"]}`，finish reason 为 `stop`、`captureTruncated=false`。后续 `search_notes` 命中原文第 3 行，relevance 为 0.15，说明这次有效扩词参与了工具检索。真实端到端用例及引用验收通过；规划器只成功一次，第一次仍超时。因此本次支持“单次时延下扩词路径可工作”，不支持“规划器每次均能按时返回”。

两次 helper 的上游观测耗时分别为 15,002 ms 和 10,572 ms；用量分别为 764 和 544 tokens（prompt 223/162，completion 541/382，其中 reasoning 489/369），上游总 usage 1,308 tokens。第一笔 usage 属于迟到且未被消费的上游响应，不能把 25,574 ms 两次 helper 时长相加当作产品等待时间；12 秒 deadline 后上游仍继续生成的问题需由验收代理修复取消转发。第二次有效规划的产品等待约 10.57 秒。作为对照，前次 240-token/8 秒配置的两次 helper 各耗时 7,318/6,516 ms，用量 463/406 tokens，输出为空并以 `length` 结束。若仅比较两次上游记录，新配置总 usage 多 439 tokens；迟到响应也产生了上游 usage。端到端用时比前次 50,786 ms 多 13.379 秒，但请求过程与模型随机性不同，不能将差异完全归因于配置。最终回答通过 `search_notes` 和 `read` 获取原文，准确回答顺序、紫色和“青铜海燕”，引用正确指向第 3 行，所有 `noteChecks` 为 true。

## 产品 configured 模式复验

2026-10-13，按 `--helper-effort configured` 运行一次，原始报告为 `dist/real-memory-acceptance/notes-product-final.json`。该模式保留产品生成的 helper effort，Agent 请求仍为 `low`。报告中的两次 `note_expand` 都明确记录 `requestedEffort=none`、`effectiveEffort=none`，所以这次确实检验了产品适配器发出的 `none`，不是验收代理把请求改成 `none`。全用例耗时 57,792 ms，结果为 complete；4 次上游调用中 3 次 HTTP 200、1 次 HTTP 502。

第一次 planner 请求在 10,679 ms 后返回 HTTP 502，没有 raw helper 输出，也没有 usage，因此虽在 12 秒内结束，但没有可供产品消费的结果。23 ms 后首个 Agent 请求启动；其 system 含 `特征分解.md` 标题导航，但不含原文正文，不能说首轮 planner 已在 12 秒内把证据注入 Agent。该失败没有触发不确定错误重试。

第二次 planner 请求以 `none` 在 1,180 ms 内返回 HTTP 200，helper 输出为有效 JSON，包含三个检索词；`finishReason=stop`、`captureTruncated=false`、`completion_tokens=25`、`reasoning_tokens=0`。随后的 Agent 请求使用 `search_notes`，命中原文第 3 行（relevance 0.2），最终答案正确，引用原文并通过全部 `noteChecks`。因此产品 configured `none` 路径已在一次成功 helper 调用中真实生效，端到端验收通过；同一次 run 也暴露出另一次 HTTP 502，完整稳定性尚未证明。首次失败和第二次成功都保留在原始报告中，不以第二次成功掩盖首次失败。
