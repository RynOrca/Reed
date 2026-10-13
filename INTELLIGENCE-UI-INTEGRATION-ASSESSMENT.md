# 把「ChatGPT 交互式 UI」融入 Reed：可行性、必要性与路径判断

日期：2026-10-13。性质：评估与建议，不是实施授权。
适用基线：Reed `2d87ed7`（自定义作品/SDK/沙箱提交 `fbcda6b`）。
参考文档：[DSH-UI-REFERENCE-NOTES.md](DSH-UI-REFERENCE-NOTES.md)、[INTERACTIVE-LEARNING-UI-PLAN.md](INTERACTIVE-LEARNING-UI-PLAN.md)、[INTERACTIVE-UI-ROADMAP.md](INTERACTIVE-UI-ROADMAP.md)。
本文的代码级别事实依据：[REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md](REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md)（只读审计，逐条标注行号）。

**结论摘要：**「ChatGPT 交互式 UI」实际牵涉**三件独立的事**：面向消费者的 Intelligent UI（呈现路由）、面向开发者的 Apps SDK（伙伴预写 widget + 网络白名单 + 权限桥）、以及 CopilotKit 的 OpenIntelligentUI（**自称该功能的开源替代品**，模型生成 HTML 且 `unsafe-eval` + 允许 CDN + 进程内存态）。Reed 的「四模式 + 受限 UI 树 + 零网络 + 零权限 + 持久化状态」在同一范式里，且**在安全性与持久性上比这三者都严**。因此：**可行性上不必新建体系；必要性上现在不应该做**——唯一该做的顺序是**先跑 C 阶段模型矩阵（真实模型陌生题），再按数据决定**优先把渲染代码从模型手里收回宿主，还是补 inspect 反馈、SVG 原语、流式预览；受控 tick 与 Canvas 最后再议。

---

## 1. 先澄清对象：这是**三件不同的事**，不能混为一谈

用户说 "Intelligence UI"，同时提到「参考项目是 OpenIntelligenceUI、dsh-genui 和另一个」。核实后这三条线索指向的东西彼此独立，混在一起谈会得出错误结论。

### 1.0 一句话最重要的事实

**CopilotKit 的 OpenIntelligentUI 官方自述就是「ChatGPT Intelligent UI 的开源替代品」。也就是说：Reed 想探索的这件事，已经有人做了一份开源参考实现，而 Reed 的四模式 + 沙箱架构与它在同一范式里——且信任模型比它更严。**

来源：[Introducing Open Intelligent UI: the Open-Source Alternative to ChatGPT's Intelligent UI](https://www.copilotkit.ai/blog/introducing-open-intelligent-ui)（CopilotKit 官方博客，2026-10-09）

### 1.1 产品线 A：Intelligent UI（面向消费者，2026-10-08）

| 项 | 本次核实到的内容 | 证据等级 |
| --- | --- | --- |
| 名称 | **Intelligent UI**（"Intelligence UI" 为记忆偏差） | 已核实 |
| 时间与伴随版本 | 2026-10-08，与 **GPT-6** 向全体用户推出 | 已核实 |
| 行为 | ChatGPT 的回答里直接包含图片、图表、按钮与交互组件，而不再只有文字 | 已核实 |

来源：官方公告 [GPT-6 and Intelligent UI for everyone](https://openai.com/zh-Hans-CN/index/gpt-6-for-everyone/)（本机 403，未取到正文）、[The Verge 报道](https://www.theverge.com/ai-artificial-intelligence/1007276/openai-chatgpt-intelligent-ui-gpt-6)、[PCMag 报道](https://uk.pcmag.com/ai/167793/chatgpt-now-explains-topics-better-using-charts-graphics-interactive-tools)。

### 1.2 产品线 B：Apps SDK / MCP Apps（面向开发者）

| 项 | 本次核实到的内容 | 证据等级 |
| --- | --- | --- |
| 形态 | UI 是 **MCP server 返回的资源**，渲染为 ChatGPT iframe 内的 HTML/JS widget，经 postMessage JSON-RPC 2.0 与宿主通信 | 镜像英文原文 |
| 三方分工 | 官方原文：MCP server「定义 tools、强制 auth、返回数据，并把每个 tool 指向 UI bundle」；widget「在 ChatGPT 的 iframe 中渲染」；「模型决定何时调用 tools，并使用你返回的 structured data 叙述体验」 | 镜像英文原文 |
| 模板来源 | widget 的 HTML/JS/CSS 由 **MCP server 开发者**编写，在 server 代码里注册（`registerAppResource(server, "kanban-widget", "ui://widget/kanban-board.html", …)`），内容取自开发者构建产物。官方要求把 URI 当**缓存键**：破坏性改动 HTML/JS/CSS 就要换新 URI → UI 代码是**部署期资产**，不是运行时产物 | 镜像英文原文 |
| 模型对 UI 的控制范围 | **模型决定何时渲染、用哪份数据渲染，但无法改变渲染代码。** 官方推荐流程：模型先调数据工具拿到 `structuredContent`，再用准备好的数据调渲染工具，「使 widget 只以最终、经过模型检查的上下文渲染一次」 | 镜像英文原文 |
| 独立 origin | 是，且可自定义：`_meta.ui.domain`（hosted components 的专用 origin，提交必需），默认 `https://web-sandbox.oaiusercontent.com` | 镜像英文原文 |
| 网络 | `connectDomains` **允许 widget 直接 `fetch`/XHR 联网**，不必走宿主桥；`resourceDomains` 管静态资源；subframe 默认禁止，声明 `frameDomains` 才可选启用，并触发更严格审核 | 镜像英文原文 |
| 其他能力收窄 | 沙箱 iframe 内无法访问 `window.alert/prompt/confirm`、`navigator.clipboard` 等特权 API；CSP/CORS 未声明的域名一律被拦 | 镜像英文原文 |
| 审批模型 | 按 **tool annotations** 驱动，非按调用方：`readOnlyHint`/`openWorldHint`/`destructiveHint` 是 tool definition **必需项**，缺失或为 null 视为 validation error；破坏性动作需明确批准。approval-gated 工具的参数在批准前**不预加载给 widget** | 镜像英文原文 |
| 分发面 | 官方：当前公开分发路径是把获批应用转为 **Codex plugins**，「Codex 是唯一具有 plugins 的产品界面」 | 镜像英文原文 |

**一处必须限定的表述：** 官方文档**没有**一句「模型不得生成或修改 UI 代码」。正确说法是**从接口面的否定推断**——全库不存在任何「模型可传入/写入 HTML、JS、CSS」的字段，模型唯一能喂给 widget 的只有工具调用参数与 `structuredContent`。所以应表述为「**没有任何模型→HTML 的通道**」，而不是「文档明文禁止」。

来源：[Add UI to your MCP server](https://developers.openai.com/apps-sdk/build/mcp-server)、[Reference](https://developers.openai.com/apps-sdk/reference)、[Plan tools](https://developers.openai.com/apps-sdk/plan/tools)、[Security & privacy](https://developers.openai.com/apps-sdk/guides/security-privacy)（**均经标注官方来源的镜像读取，仅镜像支撑**；本机对 `developers.openai.com`/`openai.com` 在所有 UA 下均 403。镜像抓取于 2026-06-27，页面自带「官方英文源已变化，请复核」警告，但本次核对的是英文原文段）。

### 1.3 参考项目：CopilotKit/OpenIntelligentUI（开源参考实现）

已通过 GitHub REST API 与仓库原文核实（完整报告见 [oiui-verification-report.md](oiui-verification-report.md)，一手证据副本在 `_oiui/`）：

| 项 | 值 |
| --- | --- |
| 身份 | `CopilotKit/OpenIntelligentUI`，**CopilotKit 官方项目**，非归档，MIT，TypeScript |
| 活跃度 | 创建 2026-03-12；最近 push 2026-10-12；**2,912 stars**；无 release、无 tag |
| **改名** | **旧名 `OpenGenerativeUI`，2026-10-09 改名**为 `OpenIntelligentUI`（同一仓库，不是两个项目） |
| 定位 | **官方 demo / 参考实现**，不是可依赖的 SDK 包 |

它的关键契约与自陈局限：

- **呈现路由的判定者是回答模型，不是外部分类器。** 付费第三方模型 Jev（TypeSafe System One，`TYPESAFE_API_KEY`，官网标价 $42/十亿输入 token）只在 13 种类型里做一次选择；真正的限选项机制是中间件按渲染器**裁剪可用渲染工具**并注入 "CRITICAL: … do not substitute another rendering tool"，且刻意不做静默降级。→ **对离线桌面应用，这条外部依赖是硬阻塞。**
- 沙箱：iframe **仅 `allow-scripts`**（无 `allow-same-origin`），注入 CSP meta 把 `script-src`/`connect-src` 限到四个 CDN，`img-src` 限白名单域名；postMessage **逐条校验 `event.source` + `type` + 数值范围**（高度 clamp 到 [50,4000]）；宿主回调只开 2 个且 Zod 校验（`sendPrompt`≤4000 字符、`openLink` 强制 https）。
- 交互：**显式点击才回传**，原文 "Never auto-send messages on load, timers, or input changes."；普通滑块与筛选只在本地运行。
- **状态是进程内 checkpoint**：`BoundedMemorySaver(max_threads=200)`，文档三处自陈「重启或扩容会丢失或分裂会话状态」。
- 明确没有跨调用 patch API："There is no supported cross-call DOM patch API, and arbitrary iframe control state is not automatically synchronized to the agent."
- 流式字段顺序是硬契约：`initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions`，理由是「CSS 先到所以永不无样式渲染，表达式最后到所以用户逐个看到行为生效」。
- **文档与实现现存不一致：** `apps/mcp/README.md` 仍示范 `sandbox="allow-scripts allow-same-origin"`——而内部评审早已把同样的写法判为 P0（可触达 `window.parent` 与宿主 cookie）。Web 主体已修，MCP 文档没跟上。

> **这个区分再次改变了结论：** 产品线 A（呈现路由）Reed 已有；产品线 B（Apps SDK）是**伙伴预写 widget + 网络白名单 + 权限桥**；OpenIntelligentUI 是**模型生成 HTML/JS + `unsafe-eval` + 允许 CDN 联网 + 内存态**。Reed 的「模型生成受限 UI 树 + 零网络 + 零权限 + 持久化状态」在**安全性与持久性上都严于这三者**。**Reed 不需要"融入"这套东西，它已经站在同一范式里更保守的一端。**

**剩余证据缺口：** `openai.com` 与 `developers.openai.com` 本机均 403，产品线 A/B 的官方原文未取到；产品线 B 依赖镜像转述。第 2、3、5 节只依赖 Reed 自己的代码，不受此缺口影响。

---

## 2. Reed 现状对照：四层里三层已经在跑，而且更严

Reed 的交互作品链路与两套方案的职责划分高度一致，区别只在「谁来写组件」。

| 方案的层 | Reed 的对应实现 | 状态 |
| --- | --- | --- |
| 呈现路由（文字／组件／生成页面） | 模型经 `interactive-explanation` Skill 选 `components` / `algorithm` / `math` / `custom`（`generation.mjs:50`） | 已实现，同产品线 A |
| 组件目录 | `CUSTOM_UI_CATALOG` 白名单（`custom-contract.mjs:31`）+ 11 类原生组件 | 已实现 |
| 结构化产物（非任意 HTML） | `generate_learning_ui({document})` 严格校验，不解析 Markdown 里的 HTML | 已实现，同产品线 B |
| 隔离执行 + 宿主桥 | `sandbox="allow-scripts"` iframe + `default-src 'none'` CSP + nonce 校验 + 白名单消息 | 已实现 |
| widget 来源 | 模型**现场生成**（`custom`）或组合原生组件 | **与产品线 B 相反** |
| 伙伴生态与分发 | —— | **结构性不可迁移**：官方称获批应用转为 **Codex plugins**，且「Codex 是唯一具有 plugins 的产品界面」——这是成为他人平台里被审核的伙伴，不是本地应用能复制的形态 |

**这里有一个决定性的事实：产品线 B 的模型输出的是 `structuredContent` + 一个指向预注册模板的 URI，模型并不生成 UI 代码。** 也就是说，业界最成熟的这套方案在「呈现」上采用的正是受限 JSON + 可信渲染器，和 Reed 的 `components` / `algorithm` / `math` 三条路径完全同构。

OpenIntelligentUI 走得更远（模型生成 HTML/JS），但它的实现同样是**先裁剪工具、再让回答模型在受限选项内决定**，而不是让模型自由发挥：

> 中间件按渲染器裁剪可用渲染工具（`RENDER_TOOLS - allowed`）+ 注入 "CRITICAL: … do not substitute another rendering tool" 系统消息

**这两家做的是同一件事：不让模型自己决定"用什么界面"，而是把选项收窄到宿主可渲染的集合。** Reed 的 Skill + 四模式选择本质上是同一个机制。

**而 Reed 的 `mode: custom`（让模型现场写 `render`/`reduce`）三家都没有对应物。** 这不是缺点，但它意味着 `custom` 是整条链路里唯一没有业界成熟先例背书的部分——所以第 0 步先测它，而不是先扩展它。

安全性上，Reed 比三家都严（逐项对照见 [第 1 节](#1-先澄清对象这是三件不同的事不能混为一谈)）：

| 维度 | OpenAI Apps SDK | OpenIntelligentUI | Reed |
| --- | --- | --- | --- |
| 模型能否生成 UI 代码 | 否（**无模型→HTML 通道**；只给结构化数据 + 模板引用） | 是（HTML/JS） | 是（受限 UI 树，**非 HTML**） |
| 渲染代码归谁 | MCP server 开发者，部署期资产（URI 即缓存键） | 生成时产生 | 模型生成，但只能组合白名单原语 |
| 模型的控制范围 | 决定**何时渲染、用哪份数据** | 决定一切 | 决定状态、计算与视图 |
| iframe origin | 专用 origin，可自定义（默认 `web-sandbox.oaiusercontent.com`） | opaque（仅 `allow-scripts`） | opaque（仅 `allow-scripts`） |
| 网络 | **`connectDomains` 允许 widget 直接联网** | 4 个 CDN | **`connect-src 'none'`** |
| 脚本执行 | 伙伴预先评审 | **`'unsafe-inline' 'unsafe-eval'`** | **无 eval，白名单树 + 置空全局** |
| 宿主能力面 | `callTool`/`uploadFile`/文件下载等 | 2 个回调（Zod 校验） | **仅白名单消息，无权限桥** |
| 特权浏览器 API | 禁 `alert/prompt/confirm/clipboard` | —— | 本来就不存在 |
| 审批模型 | **按 tool annotations 驱动**（`readOnlyHint`/`openWorldHint`/`destructiveHint` 为必需项，缺失即 validation error） | 用户显式点击才回传 | 工具调用走宿主既有审批策略 |
| 状态持久化 | 工具结果 | **进程内存，重启即丢** | **作品文件原子写 + 会话分支绑定** |
| 跨轮修改 | —— | 明确无 patch API | 版本父链，旧作品不可覆盖 |
| 分发 | 审核后转为 **Codex plugins**（官方称目前唯一有 plugins 的产品界面） | 自托管 demo | 本地桌面应用，无此环节 |

Reed 唯一比 OpenIntelligentUI 弱的是**内容表达力**（HTML/任意 CSS vs 白名单 SVG），而这正是第 3 节讨论的取舍。

两套方案的隔离取舍也已核实（`desktop/web/custom-frame.html:2`、`custom-frame-source.mjs:10`、`custom-sandbox.js:5`）：

- frame CSP 为 `default-src 'none'; script-src 'nonce-reed-frame-v1' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'`。
- 模型脚本只在 Worker 中运行；`fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/`importScripts`/`Worker`/`indexedDB`/`caches`/`setTimeout`/`setInterval` 全部被置为 `undefined` 且不可写。
- 每次操作新建 Worker，返回后立即 `terminate()`；单次 1500ms 超时强杀；frame 启动 7s、操作 2.5s 超时。
- UI 树由 `validCustomTree` 白名单校验：属性按节点类型精确匹配、颜色白名单、`d`/`points` ≤12000 字符、≤500 节点、≤12 层、序列化 ≤100000 字符。宿主渲染器只创建白名单标签，文字一律 `textContent`。

**关键判断：产品线 B 允许 widget 连接白名单域名，并经 `window.openai` 暴露 `callTool`、`uploadFile`、`getFileDownloadUrl` 等有权限的桥；OpenIntelligentUI 允许 `unsafe-eval` 与 CDN 联网；Reed 是零网络、零权限、无 eval。** 对方能放宽是因为 widget 由评审过的伙伴预先提供、并可做域名白名单治理；Reed 的组件由模型现场生成——威胁模型完全不同。**不要向它们的宽松方向移动。**

---

## 3. 真正的缺口（全部基于代码；A 是瓶颈，B–F 是待补缺口）

### A. 缺 C 阶段数据，这是当前唯一的真瓶颈

`PLAN.md:21` 的 C 阶段未打勾。现有「通过」的证据是 103 项单元/集成测试、4 组浏览器回归、42 项隔离桌面检查——**全部使用隔离模拟模型**。唯一一次真实模型证据是实验台里 deepseek-flash 生成一个简单页面（8.7 秒、138 tokens、点一下数字 0 变 1），仓库自己也写明这不构成开放生成质量结论。

也就是说：整个架构在工程上被验证了，在**教学质量上完全没有被验证**。而「模型能不能为库外的问题写出正确的组件」正是 `custom` 路径成立与否的唯一支点。继续加 UI 能力之前不测这一项，等于在未知承载力的地基上加楼层。

另外，C 阶段目前连驱动脚本都没有：`desktop/tools/` 里没有任何真实模型评估驱动，只有模拟模型的浏览器/桌面验收脚本。所以「跑 C」本身就是一件要新建工具的工作。

### B. 每次事件全量往返，动画与高频交互被结构性地挡住

现状是 `state → Worker → 全量 UI 树 → 宿主重建整个 DOM`（`custom-frame-source.mjs:15,65`）。节点上限 500、树序列化上限 100000 字符（`custom-contract.mjs:35,52`）意味着每次拖动滑块都要序列化并重建最多 500 个节点。这对离散讲解够用，对连续动画不可能——60fps 下每帧一次 Worker 往返 + 全树序列化 + DOM 重建，且当前「每次操作新建 Worker、返回结果后立即 `terminate()`」的生命周期模型（`SDK.md:22`）本身就是为一次性计算设计的。

`SDK.md:22` 已在文档里坦白「连续动画的受控 tick 尚未开放，不伪造支持」。这是当前最实的能力缺口，也是唯一需要改动安全模型的一个。

### C. SVG 词表偏小，且缺 `g` / 变换 / 裁剪 / `marker`

`desktop/web/custom-contract.mjs:28` 的图形白名单只有 `line`、`path`、`circle`、`rect`、`polygon`、`label`、`point`。没有 `g`（分组与 `transform`）、没有 `<clipPath>`、没有 `marker`（箭头）、没有 `defs`/`pattern`（填充纹理）、没有 `text-anchor`。

`custom-examples.mjs` 的三个示例全靠手算坐标绕开这一层：梯度下降示例自己写 `px`/`py` 映射函数，队列示例用 `Math.cos`/`Math.sin` 手算圆环槽位坐标。这带来一个具体且可复现的失败类：模型的坐标约定与 `point` 的像素语义不一致时，拖动会整体错位，而当前**没有任何反馈**——`reduce` 收到的是 `{x,y}` 像素值，模型忘了转换就会被 clamp 到 `minX`/`maxX`，表现成「拖不动」，报错信息里什么都不会有。

补充一个经审计确认的体验问题：`ui.point` 只有 `pointerdown`/`pointerup`，**没有 `pointermove` 拖动预览**（`custom-frame-source.mjs:44-51`），所以拖动过程中看不到点跟着手指走，只在松手时跳一次。这是「手势」缺口里最便宜也最影响手感的一处。

### D. 缺 `custom` 之外的反馈层，且缺测量反馈

`generation.mjs:55-59` 的流程是解析 → 校验 → 试运行 → （可选）审核 → 发布：`stage` 依次取 `protocol` → `runtime` → `review`。流式生成期间没有任何静态预览；失败返回 `{status, stage, message, next, attempt, remaining}`，其中 `next` 只有 `fix_and_revalidate` / `explain_failure` 两个取值（`generation.mjs:59`），**不含具体字段路径**。模型知道「错了」，但不知道「第 37 个节点的 `viewBox` 少了一个数」。同一用户请求最多 3 次尝试（`generation.mjs:54`），且计数器在校验之前就自增，**JSON 解析失败也消耗一次机会**。

`catalog` 主题同样名不副实：它只返回 `{节点类型: [允许字段名…]}` 的 prop 名表（`generation.mjs:32`），**不含**颜色白名单、数值区间、必填/可选、字段长度上限、树节点与深度上限——这些只存在于 `SDK.md` 的文字或校验代码里。模型最容易犯的恰恰是这些没被导出的约束。

**测量反馈完全缺失：** 渲染高度只在 frame 内测量并发给父页面（`custom-frame-source.mjs:66`），Worker 里的模型代码永远拿不到任何尺寸信息。这意味着「溢出」「标签压线」这类版式问题，模型既看不见也改不了，只能靠独立审核（且审核当前不传截图）。

`INTERACTIVE-UI-ROADMAP.md:48` 提到的「流式生成时只展示静态且不可执行预览」和「有限 inspect 快照」都还未实现。

### E. 一个与 UI 无关但会直接吃掉尝试次数的一致性缺陷

审计中发现三处「两套口径」的偏差，都会表现为模型难以理解的失败：

1. **字节 vs 字符：** 工具参数用 `Type.String({maxLength:65536})`（UTF-16 字符数，`generation.mjs:38`），而协议用 `Buffer.byteLength(...,'utf8')`（`protocol.mjs:34`）。中文密集的文档可能「工具参数过得去、协议校验过不去」。
2. **状态键正则不一致：** components 允许小写+短横线（`protocol.mjs:10`），custom 允许大写但**禁止短横线**（`custom-contract.mjs:6`）。跨模式迁移时容易踩坑，而两份参考文档都没点出这个差异。
3. **静默消息上限：** frame 累计 5000 条消息后**静默丢弃一切后续消息**（含 action，`custom-frame-source.mjs:73`），前端只表现为 2500ms 超时。这不影响正确性，但会让「突然卡住」难以归因。

这三条都属于「修起来便宜、但会让模型反复浪费尝试次数」的类型，建议并入第 2 步一起做。

### F. 流式生成的字段顺序契约（唯一来自参考实现的"设计思想"缺口）

OpenIntelligentUI 把生成式 UI 的字段顺序定为**硬契约**：

> `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions`
> 理由（官方原文）："CSS arrives first so the UI never renders unstyled; expressions arrive last so the user watches each behavior take effect."

Reed 的 `custom` 文档字段是 `script` 一整个字符串，**没有可流式的中间结构**，所以既做不到「永不无样式渲染」，也做不到「逐个行为生效」。而 Reed 的字段划分（`stateSchema` → `initialState` → `script` → `checks`）其实天然适合定一个类似顺序：先声明状态与初始值，再流式接收脚本，最后校验。

这是一个**纯粹的协议设计经验**，与实现无关、与安全性无关，可以在不扩大任何权限的前提下采纳。它也是第 4 步（渐进预览）能成立的前提。

### 明确不该做的两项

- **Canvas / WebGL：** 现有 SVG 词表已覆盖坐标轴、几何、路径、曲线，教学交互的绝大多数需求在此之内（梯度、队列、Softmax 三个示例都没有真正需要 Canvas）。真要做，Worker 里画完像素没法零拷贝传回宿主，只剩 `getImageData` 复制 + `postMessage` 一条路，百万像素级每帧复制不可行。收益低、代价高。
- **照搬伙伴生态 / 公共组件注册表：** 这是分发经济学，不是 UI 技术。Reed 是本地桌面教学应用，没有第三方作者，也没有把组件分发出去的场景。模型自动推广组件进公共库反而会引入「未评审代码获得更高信任」的问题。

---

## 4. 建议：先测，再按数据补缺口

### 第 0 步（必须先做）：跑 C 阶段，1–2 天量级

12 道跨领域题、至少 6 道不在现有 few-shot 与固定引擎覆盖内，覆盖数据结构、函数/线代、深度学习、Agent/RL，含至少一个新可视化结构、一种新计算规律、一次输入修改与恢复、退化与失败场景。用 3 个真实模型各跑一遍。

要记录的指标：首轮成功率、两次修正内成功率、失败类型的分布（protocol / runtime / 语义）、每次尝试的 wall-clock 与 token、超时率、以及**回退到文字的比例**。

需要先写一个最小驱动脚本（`desktop/tools/` 下，走 Reed 现有 provider 配置，隔离数据目录，不碰生产会话）。这是当前唯一值得新建的工程件。

这一步的产出决定后面所有事：
- 失败主要是 `protocol`/`runtime` → 缺的是**反馈质量**，先做第 2 步（inspect 反馈）和第 4 步（渐进预览），成本低、见效快。
- 失败主要是**语义/教学错误**（代码能跑但算法或公式是错的）→ UI 层再漂亮也没用，应优先做第 1 步（把渲染代码从模型手里收回宿主），并加强审核，而不是扩充 UI 能力。
- 三个模型全部低成功率 → **`custom` 作为默认路径的假设被证伪**，第 1 步就从「建议」升级为「必须」。

**特别注意：这个结果要与产品线 B 的对照一起读。** OpenAI 的成熟方案里，模型只输出 `structuredContent` 加一个预注册模板引用，**不写 UI 代码**；Reed 把 `custom` 提到了并列主路径的位置。如果 C 阶段显示模型写 `render`/`reduce` 的失败集中在语义层，那么「让模型扩充组件数据、由 Reed 渲染」而不是「让模型写渲染代码」，才是与业界一致的收敛方向。这不是否决 `custom`，而是给它一个由数据决定的权重。

### 第 1 步（建议做，方向性，与第 0 步的数据绑定）：让"模型填数据"优先于"模型写代码"

Reed 已有 11 类原生组件（`components` 模式）和三个固定引擎，这条路径与产品线 B 同构、且被 103 项测试和真实浏览器验收覆盖过。它的短板不是安全性，而是**表达能力**：`components` 只有有限 JSON，`Plot` 只能是条形图，放不下库外的可视化结构。

因此优先补的不是「让模型更容易写代码」，而是**提高策展组件的表达上限**，让更多真实题目落在 `components` 能覆盖的范围内：

- 给 `Plot` 增加折线/散点变体，而不是迫使模型为此写 `custom`。
- 增加一个通用「坐标轴 + 图元列表」的声明式组件，参数就是点集/线段集/标注，由 Reed 渲染——这正是当前三个 `custom` 示例在做的事，只是把渲染代码从模型手里收回到宿主。
- 把 `custom` 明确降级为「以上都表达不了时才用」，并在 Skill 里调整选择倾向。

这条路径的收益是**把最容易出错的环节（写渲染代码）从模型手里拿走**，同时保留库外表达力。代价是需要为每类新组件写宿主实现、测试和键盘/触屏规范——比扩 SDK 原语贵，但比线上跑出教学错误便宜。

是否值得做，取决于第 0 步：如果 `components` 路径的成功率显著高于 `custom`，就优先投这里。

### 第 2 步（建议做，低成本高回报）：inspect 快照 + 结构化反馈

给 `custom` 增加一个**有界**的检查结果：节点数与深度、文字长度、SVG 各图元坐标是否落在 `viewBox` 内、声明状态里各枚举值的实际取值、`render` 的耗时、以及「`point` 的 `minX`/`maxX` 与 `viewBox` 不匹配」这类已知模式。把字段路径和错误指纹装进 `next`，让模型看到「第 37 个节点的 `viewBox` 只有 3 个数」，而不是「tree 不符合协议」。

同时把 `catalog` 补成真正的字段目录：加上颜色白名单、数值区间、必填/可选、字段长度上限、树节点与深度上限（即让 `generation.mjs:32` 导出真实约束，而不是让模型从 `SDK.md` 的文字里猜）。再把第 E 节的三处口径不一致一并修掉。

顺手做掉最便宜的一处体验缺陷：给 `ui.point` 加 `pointermove` 预览（松手才提交状态，与现有「释放/按键才 commit」的语义不冲突）。

这是把 C 阶段的失败样本转成通过率的直接手段，也是 `INTERACTIVE-UI-ROADMAP.md:48` 已经写下但未实现的项目。

### 第 3 步（建议做，成本低）：补齐 SVG 原语，并加坐标约定校验

加 `g`（含 `transform`）、`clipPath`、`marker`，以及 `line`/`path` 的 `strokeDasharray`、`text` 的 `textAnchor`。**变换矩阵必须由宿主解析和校验**（只接受有限数组成的 `matrix/translate/scale/rotate`），不能让模型塞任意字符串。

同时加一条约定校验：`point` 的 `minX/maxX/minY/maxY` 必须与所在 `svg` 的 `viewBox` 合理对应，并在 `reduce` 返回的坐标落在所有 `viewBox` 之外时给出明确诊断。这一条基本消除了上面 3.C 描述的「默默拖不动」失败类。

### 第 4 步（建议做，替代 HTML 回退）：渐进预览与草稿态

解析成功就先渲染静态、不可执行的预览；校验与试运行期间卡片显示「生成／检查／待修正」，而不是空白或一次性成功/失败。发布仍要求通过全部检查。

**这里应当采纳缺口 F 的字段顺序契约**：把 `custom` 文档的流式顺序定为「`stateSchema` → `initialState` → `script` → `checks`」，先到先校验，脚本边到边做语法与白名单预检。这样既能在生成过程中给用户可看的进度，也能把「结构错误」尽量提前到流式阶段暴露，而不是等整份文档落地才失败。

`sdksandboxHtml` 这条旧路线现在应当**正式关闭**：`mode: custom` 的 Worker + 白名单树在安全上严格优于任意 HTML，而三家参考实现里唯一生成任意 HTML 的那家（OpenIntelligentUI）同时开着 `'unsafe-inline' 'unsafe-eval'` 和四个 CDN 域名，正是 Reed 明确不该走的方向。已经没有理由再补一条更危险的通道。

### 第 5 步（需要单独决策）：受控 tick

先说明一个有利条件：**Reed 已经有宿主侧动画的成熟先例**——`algorithm-player.js:13,24-37` 用 `setTimeout` 做自动播放（1400/700/180ms 三档），暂停、折叠、卸载都接好了。所以「宿主驱动 tick」在本项目里不是新概念，只是还没对模型开放。

因此正确的形态是**声明式动画**而不是把 tick 交给模型：模型只声明「哪个状态量随时间变化、时长、缓动」，宿主复用算法播放器那套计时器驱动并直接更新 SVG 属性，避免每帧 Worker 往返。若要保留计算型动画，则必须先改「每次操作新建 Worker、返回即终止」的生命周期模型（改成带时限的常驻 Worker），并补上暂停/离屏/卸载语义、`prefers-reduced-motion`、delta 上限和每作品累计 CPU 预算。

这是唯一触及现有隔离模型的改动，**只有在 C 阶段数据证明「动画缺失导致真实题目失败」之后才做**。

### 生产库/公共 SDK 沉淀：推迟

单作者阶段没有收益。等出现真正被多个作品复用的模式，再走「评审后提炼进 SDK」的流程。

---

## 5. 两条与 UI 无关但同等重要的判断

**第一，更强的呈现能力会放大教学错误的说服力。** 现在卡片虽然标注「教学内容待核对」，但一个能拖、能跑、有坐标轴的错误交互比一段错误的文字更难被学习者识别。`INTERACTIVE-LEARNING-UI-PLAN.md:73` 的三层验收（协议/渲染/事实）是对的，但目前只有前两层被真实执行过。在事实层没有可行判定手段之前扩充视觉表现力，是净负收益。

**第二，路线图需要一次排序修正。** `INTERACTIVE-LEARNING-UI-PLAN.md` 把「隔离 HTML 回退」写成第 4 阶段，而 `mode: custom`（更安全、更通用的方案）已经先落地了。该阶段应当标记为已废弃，而不是继续留在计划里，否则会诱导实现一条不必要的通道。

---

## 6. 需要用户拍板的三件事

1. **对象确认：** 你想借鉴的是三条线里的哪一条？① Intelligent UI 的自动呈现（Reed 已有同构实现）；② Apps SDK 的 widget 机制（伙伴预写 + 网络白名单 + 权限桥，与 Reed 相反）；③ CopilotKit OpenIntelligentUI 的契约细节（**它自称就是这条功能的开源替代品，而 Reed 已经在做同一件事且更严**）。如果是 ③，重点应该从「要不要做」转成「对照它的契约清单，补齐 Reed 缺的那几项」（即第 3 节缺口 F 与第 4 步）。
2. **顺序确认：** 是否同意「先投入 C 阶段模型矩阵（真实模型陌生题），暂缓一切 UI 能力扩充」？这是本评估的核心建议。
3. **风险偏好：** 如果 C 阶段显示 `custom` 成功率低而 `components` 高，是否接受把「提高策展组件表达上限、把渲染代码收回宿主」作为主线，`custom` 降级为明确兜底？还是愿意继续投入提升模型写代码的成功率（更多 few-shot、更强反馈、可能换模型）？

---

## 附：本文的证据边界

| 部分 | 证据强度 | 说明 |
| --- | --- | --- |
| 1.1 Intelligent UI | 媒体一手报道 | 名称、日期（2026-10-08）、伴随版本（GPT-6）由 The Verge 与 PCMag 报道核实；**openai.com 官方公告正文未取到**（本机 403） |
| 1.2 Apps SDK | **仅镜像支撑** | `developers.openai.com` 与 `openai.com` 在本机对所有 UA 一律 403。内容取自标注官方来源、保留英文原文段的中文镜像（抓取于 2026-06-27，页面自带「官方英文源已变化」警告）。**建议在做出任何投入决定前用未被拦截的网络出口复核** |
| 1.3 OpenIntelligentUI | 强（官方 API + 仓库原文） | 经 GitHub REST API 与仓库内文件原文核实，一手证据副本在 `_oiui/`。注意本机 `hosts` 把 `github.com` 劫持到 `127.0.0.1`，GitHub 网页与本评估无关，但后续查 GitHub 请走 `api.github.com` |
| 2、3、5 节 | 强（可直接核对） | 基于本次实际阅读的 Reed 源码，逐条标注文件与行号，明细见 [REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md](REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md) |

**关于一条承重论据的表述纪律：** 本文主张的是「Apps SDK 中**不存在模型→HTML 的通道**」，这是从接口面的否定推断（全库无任何「模型可传入/写入 HTML、JS、CSS」的字段）。**不要引用成「OpenAI 官方明文禁止模型生成 UI 代码」——官方文档没有这句话。**

本文不含任何「已执行测试」的结论；本次未运行测试、未修改任何源码（仅新增本文档、[实现审计](REED-INTERACTIVE-UI-IMPLEMENTATION-AUDIT.md)、[OpenIntelligentUI 核实报告](oiui-verification-report.md)三份文档，并在 `.gitignore` 中加入 `/_oiui/`）。`_oiui/` 是上游 MIT 源码的只读证据副本，**已加入 `.gitignore`，本仓库不重新分发它**。
