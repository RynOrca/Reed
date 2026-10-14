# Reed 项目接手规则

- 全部消息用中文。项目为 Windows Tauri/Rust 桌面 + Node.js PI Agent，版本 0.2.2。
- 当前只操作 `0.2.2` 分支；不得改 main、强推或公开发布 Release。
- 先读 `docs/HANDOFF-DEEPSEEK-2026-10-14.md`，再读 `PLAN-0.2.2.md` 和相关源码。
- 用户已确认本轮修复计划：停止优先，其次总览、检索性能和卡片；无需重复确认同一计划。新增或明显改变范围先讨论。
- 用户要求全部 bug 修完后再统一构建和测试，中途只做必要定向验证，不每修一项就全量检测。
- 每项成果独立 commit，更新计划状态；每次更改记入 CHANGELOG，最近十条，记录 Git hash。WIP 不得声称修复或验收完成。
- 启动项目 Node 前检查同项目已有进程；如有，先询问是否关闭再启动。不要误杀 Codex/CUA/其他项目 Node。
- 真实 DeepSeek 旧轮两次付费授权已用尽。本轮不新增付费调用，不发送真实笔记；需要时必须重新取得明确授权。优先合成笔记、本地模拟服务、隔离 profile。
- 不在真实数据上测试 DELETE/PUT 覆盖；先创建 test-xxx 数据。已有用户总览不得覆盖。
- 软件不可逆删除需两次点击确认，3 秒超时取消。破坏性修改前先提交保全。
- 跨页面持久状态进 store，页面临时状态留组件。async 读取 store 最新值用 getState()，避免闭包旧值覆盖消息。
- 服务端代码变更须重启实际服务/Agent；前端 HMR 不能证明服务端已加载新代码。
- 最高思考档位 medium；不得使用 high/xhigh。不得把向量检索当模型超时修复。
- 阶段汇报同时说明剩余计划。不得把历史测试、源码存在、模拟测试或 off-hi 冒充本轮真实 medium 场景通过。
- 根目录原先没有 AGENTS.md/RTK.md；用户此前引用的 RTK.md 未找到，不能声称已阅读。
- 不安装替换用户 Reed；交付为新构建、验收报告、0.2.2 源码及现有 Release Draft，保持 Draft。

入口：`desktop/agent/bridge.mjs`、`desktop/web/app.js`、`desktop/web/settings.js`、`desktop/src-tauri/src/main.rs`。
命令：`npm test`（完整 Agent），构建/原生隔离验收命令与环境见交接文档。
