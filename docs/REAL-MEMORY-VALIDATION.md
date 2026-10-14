# 工作经验真实模型定向验证

后续进展：画像纠正已在独立诊断中定位为输出预算耗尽并定向修复，真实替换/重启成功，详见 [画像纠正诊断](PROFILE-CORRECTION-DIAGNOSIS.md)。本文原始失败记录仍保留。

日期：2026-10-13
基线 Git 提交：`4343d319fa5c5099bae97c494402e21ae2d3c430`
模型：`qwen3.8-27b-long`。后续 continuation 与补验代理显式强制出站 `effectiveEffort=low`；更早的训练产物没有记录实际出站 thinking，不能将它们归为已验证 low。
范围：真实模型、合成任务、隔离临时 profile / 项目目录 / 笔记库，以及只允许输出固定文本的本地 MCP 命令工具。脚本只读取当前选定服务配置与凭据以连接用户当前配置的模型，不修改真实配置；不读写真实笔记或记忆，不记录或展示密钥。未做全量测试、构建或安装。

## 结果

| 阶段 | 结果 | 证据与限制 |
| --- | --- | --- |
| 初次错误与修正训练 | 通过，存在一项超出证据的经验内容 | 真实 Windows PowerShell 命令 `Write-Output 'amber' && Write-Output 'violet'` 返回退出码 1，报 `InvalidEndOfLine`；改为分号后退出码 0，标准输出为 `amber`、`violet`。保存了活动经验 `ce267a35-465b-4c39-9463-fc9d42164017`。经验还加入 `if ($LASTEXITCODE -eq 0)` 条件执行分支，但没有运行或验证该分支，不能视作已验证方法。 |
| 关闭工作经验 | 完成，68,637 ms | 与开启组使用逐字相同的任务提示。模型检查空目录并报告无法执行，没有调用 MCP shell。 |
| 重启后开启工作经验 | 完成，86,286 ms | system 上下文包含训练经验 ID，日志记有一次 `recalled`。随后真实调用 Windows PowerShell，分号命令退出码 0、输出两行，shell 耗时 634 ms。没有 `reported_use` 记录，因此只能说实际命令与经验修正一致，不能证明模型显式归因采用了该条经验。 |
| 跨 PowerShell 环境 | 失败（发现上下文泄漏），132,880 ms | 显式选择 `pwsh`，真实分号命令退出码 0、输出两行，shell 耗时 1,117 ms。但逐请求检查发现初始 system 没有训练经验，后续 agent 请求在 MCP discovery 后、执行 shell 前重新注入训练 ID 和 PowerShell 5.1 的 `&&` 修正规则。实际命令未使用 `&&`，所以没有观察到命令误用；上下文隔离本身未通过。 |
| 保存项目工作流 | 超时，150,015 ms | 实际执行分号命令成功（672 ms），但隔离 Agent 等待超时；最终 profile 中没有新增项目经验，未生成项目经验 ID。 |
| 项目 A/B 边界、经验纠正/重启召回 | 未测 | 验收在保存项目工作流阶段停止，后续用例未运行。 |

## 证据解释

这次确实区分了经验保存、召回与实际工具行为：保存由训练产物中的活动条目证明；召回由后续 system 上下文中的 ID 和 `work-usage.jsonl` 的 `recalled` 记录证明；实际行为由隔离 MCP 捕获的 shell、命令、退出码和标准输出证明。使用日志没有 `reported_use`，所以没有把工具成功归因成模型报告采用。开启记忆的用例实际执行了与经验修正一致的命令，但执行顺序中先有目录检查和 MCP 发现，不能据此声称经验改变了首次行动。

跨环境请求的初始 system 未召回经验，但在模型发现 MCP 工具后的后续请求重新注入了 Windows PowerShell 5.1 条目；该 ID 同时出现在该阶段的 `recalled` 记录中。这是本轮发现的跨 Shell 召回边界缺陷。实际 pwsh 命令选择分号，因而命令执行成功并不能抵消上下文泄漏，也不能证明 pwsh 环境下行为无误。

关闭/开启用例每组只有一次，且模型输出具有随机性；虽然提示完全相同，但只有开启组成功调用 shell。这只是本轮观察，不是统计显著的 A/B 结论，也不能证明记忆提高了成功率或降低了耗时。训练条目中未执行的 `$LASTEXITCODE` 分支是需要修正的真实可靠性问题：它被写入有成功证据的经验正文，超出了本次工具证据。

项目工作流阶段耗时达到 150 秒上限后，Agent 超时，流程清理了临时目录。最终报告保留在 `dist/real-memory-acceptance/report.json`；训练与复测的输入产物分别为 `dist/real-memory-acceptance/train-fixed.json`、`dist/real-memory-acceptance/initial-timeout.json` 和 `dist/real-memory-acceptance/evidence-retry-before-fix.json`。用于后续局部复验的只读源码快照位于 `dist/real-memory-acceptance/snapshot-agent`，其 `bridge.mjs` SHA-256 为 `85A42E0CBAE7B49E7BF8B00608C4151F765394AFDED48D2344394D738CF2DE82`；依赖目录是现有 `desktop/agent/node_modules` 的 junction，没有复制用户数据。补充验收代理修复后仅进行本地代码检查与定向回归，不将本地回归等同于真实模型行为通过；真实模型补测结果见后续记录。

## 结论边界

已观察到真实 PowerShell 5.1 错误被实际命令修正、经验被保存并在重启后召回；跨环境请求则发现该经验在后续请求泄入 pwsh 上下文。经验正文超出证据的条件分支、Shell 过滤缺陷和项目经验保存超时尚未解决。真实模型笔记检索通过；画像纠正被保存审查拒绝，重启后仍是旧偏好，因此画像纠正没有通过。项目隔离和工作经验纠正/失效历史未测。上述结果仅适用于本次模型、配置和合成隔离任务，不构成长期可靠性保证。

## 后续快照补验

代码快照：`dist/real-memory-acceptance/snapshot-agent/bridge.mjs`；模型仍为 `qwen3.8-27b-long`。此轮和其前一次 continuation 的所有出站请求都被代理强制为 `effectiveEffort=low`。笔记用例耗时 67,490 ms；画像最终重试的 `profile-original`、`profile-correction`、`profile-after-restart` 分别耗时 43,162、93,724、22,502 ms。最终画像补验共 9 个模型请求；限制为总计 360 秒、每个 provider 请求 60 秒、每用例 5 次请求、整套 18 次请求。只重跑画像生命周期，没有重复已通过的笔记调用。

- 笔记检索通过：实际调用 `search_notes`，模型引用 `特征分解.md#L3`，还原“先画两支定向杆”、紫色、验收口令“青铜海燕”，输出与笔记相符的原文片段。详细响应与工具结果保存在 `dist/real-memory-acceptance/continuation-notes-profile-partial-timeout.json` 的 `notes-paraphrase` 用例。
- 画像原偏好保存通过：调用 `record_learning_event`，写入用户明确给出的“先给结论，再解释原理”，临时 `learner.json` 记录了对应证据。
- 画像纠正失败：两次 `record_learning_event` 参数相同，均为 `operation=replace`、`targetSubject=回答顺序`、`kind=preference`、`detail=先讲原理，再给结论`，并引用用户原话。工具返回 `isError=false`，但正文两次均为“未保存：当前内容缺少明确的长期价值或可靠证据。”；纠正后 `learner.json` 仍保留旧值。
- 不能把上述工具文案直接解释成模型判定“无价值”。两个 `value_gate` 上游请求均 HTTP 200，耗时 8,171 ms 与 8,870 ms，低于代码的 20 秒内部超时；但代理未记录 value gate 的原始响应 JSON，冻结版本把拒绝决策、输出格式/解析不合规及内部取消映射为同一工具文案。因此现有证据只能确认“保存审查未通过”，无法区分具体分支，也没有证据表明发生了 HTTP 超时。
- 重启后画像仍为旧值，回答先给结论再解释原理，与仍存的旧偏好一致；这是“纠正未保存后旧值持续存在”，不表示纠正后的新值成功恢复。
- 首次补验报告 `continuation-notes-profile-retry.json` 记录了原偏好保存请求超时，随后代理响应处理因重复发送 HTTP header 中止；报告副本保存在 `continuation-notes-profile-partial-timeout.json`。修复该验收代理错误后，画像最终重试正常完成；启动 `snapshot-agent` 曾遇到 `spawn EPERM`，失败报告单独保存在 `continuation-notes-profile-spawn-failed.json`。

补验代理修复只在此隔离快照上验证，不代表产品源码修复或真实用户数据行为已经复验。本地回归仅能说明代码层面检查通过；本报告中的真实模型结果仍以具体运行证据为准。

## 产品代码后续回归（非真实模型复验）

本轮后续产品源码调整由主代理完成，六个相关文件的 24 项局部测试通过；没有进行全量测试或构建。该结果是本地代码回归，不是对真实模型行为的复测。尤其画像纠正的真实模型失败仍未解决：合成原偏好可以保存，但明确纠正被保存审查拒绝，重启后仍返回旧偏好。下一步应先保留并检查 value gate 原始输出/错误，再用受控合成数据定向诊断；本轮不再追加真实模型调用。
