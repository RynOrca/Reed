# 0.2.2迁移记录（2026-10-14）

## 基线与范围

起点origin/main `9fb92bb`，main工作树与原成果基线6850a1d一致。目标分支0.2.2，计划提交1f75c1e；26项成果逐个cherry-pick -x，无冲突；原用户签名/打包配置先独立保存39383b3，再独立迁入6b9856e。原fix/0.2.1分支完整保留，不重写历史。未推送或发布。

保留：笔记库总览恢复/持久化/分页/轻量检索与原文引用；经验生命周期/证据/相似合并/召回；长期记忆与基础画像可靠性；统一模型调度/默认串行/实验性并行；browser旧端口及无效重试修复；重连与保存反馈。独立检索模型仍未实现，不列为已交付。

暂停：交互式学习界面、交互组件/自定义UI SDK及其实验路线。未合并feature/interactive-ui-shelved；HEAD文件清单未发现interactive、ui-lab、custom-ui路径。main原有普通聊天学习、学习目标、画像和复习事件仍保留，与交互式组件无关。

## 保护与版本

切换前两处原文件备份于dist/migration-0.2.2，含SHA256及源26提交清单。tauri配置迁入后与备份字节一致；installer由Git规范化换行，文本内容一致。只同步Reed/Agent顶层及锁文件根包版本、Cargo自身包和Tauri配置至0.2.2，不改依赖版本。版本变更前desktop/agent、desktop/web、desktop/tools与源fix分支无差异。

CHANGELOG仅保留最近十条；旧记录仍在Git，不删除原功能提交及历史报告。历史报告中的已通过结果属于原提交，不冒充0.2.2新构建验收。

## 提交映射

| 原提交 | 0.2.2提交 | 成果 |
|---|---|---|
| `f3a468b` | `fe47917` | fix(knowledge): restore vault overviews and strengthen personal knowledge recall |
| `4d690e5` | `2b1d81c` | fix(memory): delete scoped experiences by stable identity |
| `501bff7` | `fcf664a` | feat(memory): add lightweight experience lifecycle and persistent knowledge search |
| `4343d31` | `a6e0f06` | docs: record memory lifecycle validation and revision |
| `a51e226` | `a8557f6` | fix: bind work memory to verified commands and shell context |
| `d68089f` | `4cf7c86` | docs: record work reliability milestone and validation limits |
| `63dfaf9` | `759bcee` | fix: reserve reasoning budget and diagnose memory review failures |
| `1b29c5f` | `91d1292` | fix: preserve partial note indexes without exposing stale evidence |
| `ee208fe` | `7fafc45` | docs: record profile correction and knowledge retrieval milestones |
| `1b5cbde` | `cbe6464` | fix: close real work memory cycle and bound auxiliary reasoning |
| `f80aeb9` | `2895cbb` | fix: include memory runtime dependencies in portable package |
| `364987c` | `bd7e1da` | docs: record real learning lifecycle acceptance and delivery limits |
| `5ccfbfd` | `5c6597c` | perf: avoid blocking note expansion before model replies |
| `8c55e96` | `0495697` | fix: persist review intervals and report the saved date |
| `b73cfe0` | `0c6ed48` | fix: recover cancelled note plans and audit persisted review dates |
| `00216d5` | `48cfbd3` | docs: finish usability acceptance and clarify recall result wording |
| `1483ff9` | `dd7badc` | fix: restore session history and busy state when reconnecting |
| `d64dc2f` | `2352517` | test: prepare fresh native acceptance and record latency baseline |
| `c49868d` | `257cb3d` | test: complete isolated native desktop acceptance |
| `f3ef168` | `f4e0898` | test: diagnose upstream response latency before note retrieval changes |
| `6d0311d` | `9f5c312` | test: isolate single-slot model latency and reproduce background contention |
| `d4e8d7c` | `7e5d30c` | feat: serialize model requests and add experimental concurrency settings |
| `8e31590` | `da17782` | docs: record model scheduling implementation version |
| `c88f58d` | `d56e424` | test: verify serial Qwen scheduling and audit encoded note citations |
| `ec49c3b` | `530f5a6` | fix: avoid stale browser debug ports and stop repeated failed reviews |
| `ed16c9d` | `a1a4c5d` | docs: record browser reliability fix version |
| `39383b3` | `6b9856e` | chore: preserve user signing configuration for 0.2.2 migration |

## 验证与剩余

新分支13个相关测试文件的66项用例全部通过（30.0秒），覆盖笔记库恢复/分页/检索/索引、经验/画像、调度/真实Bridge模拟HTTP、browser真实隔离Edge及视觉门控、配置持久化和初始化。没有运行全量测试，也未调用真实模型。静态核对main为HEAD祖先，7份版本文件均为0.2.2，CHANGELOG恰好10条；除Agent两份版本文件外，desktop/agent、web、tools与保全后的源分支一致。未引入interactive/ui-lab/custom-ui路径。

检测到旧便携包Reed21116/Node3124，按用户明确授权核对目录并关闭后才启动测试。源码版本0.2.2不等同已生成安装包；当前未构建、安装或发布，已安装Reed保持原样。服务等待与ninfer取消语义尚有原报告中的边界，实验性并行未在用户单槽Qwen上验收。
