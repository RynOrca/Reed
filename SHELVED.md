# 交互式 UI 能力：暂时搁置

状态：**暂时搁置（SHELVED）**　决定日期：2026-10-13
分支：`feature/interactive-ui-shelved`　基线：`main`（`75c49b1` 之后的所有交互 UI 提交都在本分支上）

## 决定

暂停「让模型为库外问题现场编写交互组件」这条主线的继续投入，也暂停把 ChatGPT Intelligent UI / Apps SDK / CopilotKit OpenIntelligentUI 的做法引入 Reed。

`custom` 沙箱与四种作品模式**代码是完整可运行的**，不是半成品；搁置的是**方向**，不是**质量**。

## 为什么搁置

评估结论见 [INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md](INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md)。三条核心理由：

1. **对标对象不可迁移。** ChatGPT 的 Intelligent UI 是「宿主预置组件 + 模型挑选数据」，Apps SDK 是「伙伴预写 widget + 网络白名单 + 权限桥」，OpenIntelligentUI 是「模型生成任意 HTML + `unsafe-eval`」。Reed 的「模型写受限 UI 树 + 零网络 + 零权限」与三者信任模型都不同，把它当追赶目标没有意义。
2. **瓶颈不在 UI，在未验证。** 真实模型对陌生题目的生成质量**从未被测过**；现有全部「通过」都来自隔离模拟模型。
3. **更强的呈现会放大教学错误的说服力。** 一个能拖、能动、有坐标轴的**错误**交互，比一段错误文字更难被学习者识破。事实层没有判定手段之前，扩视觉表现力是净负收益。

## 本分支包含什么

除本文件外，本分支相对 `main` 包含：

**全部交互 UI 实现**（阶段 1–3、完整算法执行、树与数学、custom SDK）
- `desktop/agent/interactive-ui/` —— 协议校验、作品存储、生成工具、独立审核、custom 校验
- `desktop/web/` 下的 `interactive-ui.js`、`interactive-components.js`、`custom-*`、`algorithm-player.js`、`math-explorer.js`、`kmp-*`、`quicksort-trace.mjs`、`heapsort-trace.mjs` 等
- `desktop/agent/skills/interactive-explanation/` —— 内置 Skill 与 SDK 参考
- `experiments/intelligent-ui-lab/` —— 独立 HTML 生成试验台
- 对应测试、浏览器验收与便携包脚本

**本次调研产物**
- `INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md` —— 可行性、必要性与路径判断
- `REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md` —— 逐条带行号的实现事实清单
- `oiui-verification-report.md` —— OpenIntelligentUI 核实报告
- `desktop/tools/eval-interactive/` —— 六科 × 6 题分层题库 + 真实模型评估驱动

## 搁置期间的实际行为

交互讲解能力由**角色开关 `interactiveUiEnabled` 控制，默认关闭**。因此即使运行本分支的构建：

- 关闭时（默认）**不注册生成工具、不注入 Skill**，执行入口还会二次校验权限
- 普通聊天与其他角色行为不受影响
- 已生成的历史作品卡片仍可查看与操作

也就是说，搁置状态下这套能力对用户是**不可见**的，不需要删代码。

## 恢复这条线时要先做什么

按评估文档的结论，**第一步不是加功能，是补评估能力**：

1. **给 `components` / `algorithm` / `math` 三个模式补运行时校验。** 目前只有 `custom` 有真实试运行，另外三个只做静态协议校验——报告里的 `static-only` 只证明格式合法，不证明渲染正确、更不证明讲对了。这是评估表从「半可信」变「真可信」的关键一步。
2. **跑真实模型基线。** 用 `desktop/tools/eval-interactive/` 跑六科 × 6 题，拿到「学科 × 需求类型」覆盖率表，并区分失败原因（组件库不足 / 模型能力不足 / 不该用交互）。
3. **按数据决定方向**：失败集中在协议/运行时报错 → 补 inspect 反馈与字段路径；失败集中在语义错误 → 转成「模型只填数据、Reed 负责渲染」，提高策展组件表达上限；`over-generated` 偏多 → 在 Skill 里显式教「什么时候不该做交互」。
4. **正式关闭「隔离 HTML 回退」计划。** 安全上严格劣于现有的 `custom` 白名单树方案，不应实现。

## 明确不要在恢复时做的事

- 不要为了「媲美 ChatGPT」而放松沙箱：保持零网络、零权限、无 `eval`、白名单 UI 树。
- 不要在事实层没有判定手段之前扩充视觉表现力。
- 不要把 Canvas / WebGL 当作优先项——现有 SVG 词表已覆盖教学交互的绝大多数需求，而像素回传代价高。
- 不要照搬伙伴生态或公共组件注册表——单作者本地应用没有分发场景。

## 参考

- 评估与建议：[INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md](INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md)
- 实现事实清单：[REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md](REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md)
- 原始路线图：[INTERACTIVE-UI-ROADMAP.md](INTERACTIVE-UI-ROADMAP.md)
- 实施方案：[INTERACTIVE-LEARNING-UI-PLAN.md](INTERACTIVE-LEARNING-UI-PLAN.md)
- 第三方参考笔记：[DSH-UI-REFERENCE-NOTES.md](DSH-UI-REFERENCE-NOTES.md)
- 评估工具用法：[desktop/tools/eval-interactive/README.md](desktop/tools/eval-interactive/README.md)
