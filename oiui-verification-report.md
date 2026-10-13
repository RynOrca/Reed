# CopilotKit/OpenIntelligentUI 核实报告

核实时间：2026-10-13（本地时区 UTC+8）。数据来源：GitHub REST API、仓库内文件原文、CopilotKit/TypeSafe 官方站点。
一手证据副本（README/docs/源码/官方页面文本）已落盘到 `_oiui\` 目录。

---

## 一、已核实事实

### 1. 仓库身份核实

| 项 | 值 |
|---|---|
| 完整名称 | `CopilotKit/OpenIntelligentUI` |
| Owner | `CopilotKit`（Organization，id 131273140） |
| 是否仍存在 | 存在，public，`archived=false`、`disabled=false` |
| 创建时间 | 2026-03-12T20:40:06Z |
| 最近提交 / push | `pushed_at` = 2026-10-12T19:08:07Z；`updated_at` = 2026-10-13T04:41:15Z（即核实前约 8 小时） |
| Star 数 | 2,912（watchers/subscribers 9，forks 333） |
| License | MIT（API `license.spdx_id = "MIT"`） |
| 语言 / 规模 | TypeScript；1366 KB；default branch `main`；topics 含 `agentic-visualization`、`generative-ui`、`visualization` |
| Issues / PR | open issues 42、open PR 53（GitHub Search API） |
| Releases | 无发布、无 tag（`/releases` 返回空数组） |
| 主页 | https://opengenerativeui.copilotkit.ai/ |

一手来源：[仓库主页](https://github.com/CopilotKit/OpenIntelligentUI) · [api.github.com/repos/CopilotKit/OpenIntelligentUI](https://api.github.com/repos/CopilotKit/OpenIntelligentUI)

**改名历史（重要）**：查询被改名前地址 [github.com/CopilotKit/OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) 时，API 返回的 `full_name` 已是 `CopilotKit/OpenIntelligentUI`（GitHub 的仓库改名重定向）。提交记录亦证实：

> `2026-10-09 09:19:32  Anmol Baranwal  chore: rename Open Generative UI to Open Intelligent UI`

因此：你给的目标名 `OpenIntelligentUI` 是**现名**；`OpenGenerativeUI` 是旧名（2026-10-09 前），不是另一个仓库。

一处细节：`LICENSE` 首行为 `Copyright (c) Atai Barkai`（Atai Barkai 为 CopilotKit 创始人），不是 "CopilotKit, Inc."。

### 2. 它到底是什么

README 首屏原话：

> "**An open-source chat interface that turns questions into explanations, comparisons, and working tools.**"
> "Built with [CopilotKit](https://github.com/CopilotKit/CopilotKit) and [AG-UI](https://docs.ag-ui.com/introduction)."

一句话：**它是一个把「问一句」变成可交互解释、对比和可用小工具的对话式参考应用**（chat app / demo），而不是一个可供依赖的框架包。

**归属：CopilotKit 官方，不是第三方 demo。** 依据：
- 仓库位于 CopilotKit 官方组织下；
- CopilotKit 官方博客发布：[Introducing Open Intelligent UI: the Open-Source Alternative to ChatGPT's Intelligent UI](https://www.copilotkit.ai/blog/introducing-open-intelligent-ui)（By Anmol Baranwal and Eli Berman, October 9, 2026）——"Today, we're releasing Open Intelligent UI - the open-source alternative to ChatGPT's Intelligent UI!"；
- 提交者为 CopilotKit 团队成员（Jerel John Velarde、Anmol Baranwal、Nathan Tarbert）。

但它是**官方 demo / 参考实现**，不是官方 SDK：

> "It's built on CopilotKit's Open Generative UI and the agent behind it runs on LangChain Deep Agents."（同上博客）

`docs/bring-to-your-app.md` 也自述为「adopting the CopilotKit + LangGraph **patterns** from this project into your own application」。

### 3. 架构事实

**运行栈**（[README「How it works」](https://github.com/CopilotKit/OpenIntelligentUI#how-it-works)、[docs/architecture.md](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/architecture.md)）：

```
apps/app/                Next.js + CopilotKit frontend
apps/agent/              Python Deep Agent + FastAPI
apps/mcp/                Optional standalone MCP server
packages/design-system/  Shared theme, SVG, and form styles
```

- 前端：Next.js `16.1.6` + React 19 + `@copilotkit/react-core|react-ui|runtime@1.55.2-next.1`（**预发布版本**）+ `@jetbrains/websandbox@1.2.1`（`apps/app/package.json`）。
- Agent：Python 3.12 + FastAPI + LangGraph + `create_deep_agent`（Deep Agents）+ AG-UI 端点；`LangGraphHttpAgent → FastAPI agent`。
- 语言：TypeScript（前端）+ Python（agent）。
- 工程链：pnpm + Turborepo；Python 用 uv；可选独立 MCP server（Node，可 Docker）。
- 请求流原文："User prompt or chat starter suggestion → CopilotKit chat / agent run → Next.js /api/copilotkit → LangGraphHttpAgent → FastAPI agent → model + applicable tools and skills → text, native component, or generateSandboxedUi → CopilotKit activity stream → browser renderer"。

**路由模型：确实依赖付费第三方「Jev」。** [docs/visualization-routing.md](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/visualization-routing.md)：

> "Jev (`jev-latest`) makes one typed presentation decision for each new user message through [TypeSafe's System One API](https://docs.typesafe.ai/introduction/quickstart)."

配置项 `TYPESAFE_API_KEY`、`JEV_MODEL=jev-latest`（[.env.example](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/.env.example)、[render.yaml](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/render.yaml)）。TypeSafe 官网自述 System One 为商业模型，公布价格：

> "Jev.Cost $42 Per Billion input tokens. 238x Lower input price than Claude Fable 5.1" —— [typesafe.ai](https://typesafe.ai/)

> "Get an API key from the TypeSafe console." —— [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)

**部署形态：Next.js 服务端 + 独立 Python 服务，可本地也可云端。** `render.yaml` 定义两个 Render 服务 `open-generative-ui-agent`（Python 3.12.6，`uv run uvicorn main:app`）与 `open-generative-ui-app`（Node 22，`next build` / `next start`），`plan: starter`，`minInstances: 1 / maxInstances: 3`。本地默认 `localhost:3000` + `localhost:8123`。可见它**不是**桌面应用形态，也没有本地进程内嵌 agent 的方案。

### 4. 「呈现路由」怎么做

判定者是**模型**，不是规则。13 种可选可视化类型（`text / table / bar_chart / line_chart / scatter_plot / distribution / part_to_whole / flowchart / static_diagram / interactive_diagram / animated_route / map / calculator`）定义在 `apps/agent/src/visualization_router.py` 的 `VISUALIZATIONS` 常量里。类型 → 渲染器映射（docs 表格原文）：

| Selected visualization | Renderer |
|---|---|
| Text | Normal chat answer |
| Table | A2UI Table catalog |
| Bar/line/scatter/distribution/part-to-whole chart | Open Generative UI |
| Flowchart, static or interactive diagram | Open Generative UI |
| Calculator | Open Generative UI |
| Map or animated itinerary | Open Generative UI |

实现要点（源码 `visualization_router.py`）：
- 调用 `POST https://api.typesafe.ai/v1/systemone`，timeout 15s，请求体是 `{model, state:{conversation}, questions:{visualization:{type:"choice", instructions, criteria}}}`；
- 输入只取**最近 4 条** human/ai 文本消息、每条截断 6000 字符；原文强调 "It does not receive API keys, system instructions, raw tool outputs, or generated tool code."；
- 返回需通过 pydantic 校验（`choice` 必须在 `VISUALIZATIONS` 内、`probabilities` 合法），否则抛错；
- 决策存进 thread state（`visualization_turn` / `visualization_decision`），用 user message id 作为 turn 键，工具续跑时复用；
- `routed_request()` 在模型调用前**过滤渲染工具**（`RENDER_TOOLS - allowed`），并把一段 "CRITICAL: Jev presentation decision for this user turn..." 注入 system message；a2ui 与 map/animated_route 还有额外的长指令模板。

失败语义：

> "Jev authentication failures, invalid choices, and timeouts fail the turn with a retryable error; there is no silent fallback claiming that Jev made a decision."

局限自陈：

> "Routing is a model judgment, not a guarantee of the objectively best visualization."

### 5. 生成式页面的技术实现

**渲染在隔离 iframe（宿主页面内嵌的 iframe），不是宿主 DOM 直插。**

- 载体是 `generateSandboxedUi` 工具 + 运行时 `openGenerativeUI` rail + `OpenGenerativeUIMiddleware` 转成 `open-generative-ui` activity 事件。
- 字段流式顺序（硬契约）：`initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions`；理由是 "CSS arrives first so the UI never renders unstyled; expressions arrive last so the user watches each behavior take effect."
- 两段式渲染：html 未完成时用 Idiomorph 把每批增量 morph 进 preview iframe（防闪烁）；html 完成后销毁 preview，创建最终 Websandbox iframe，注入 design-system CSS 与 CDN importmap，执行 `jsFunctions` 再逐条执行 `jsExpressions`。

**沙箱属性 / CSP / postMessage 边界（均已核实到具体代码）：**

- `iframe.sandbox = "allow-scripts " + sandboxAdditionalAttributes`，而仓库传 `allowAdditionalAttributes: ""`（`renderer.tsx`）。且 `@jetbrains/websandbox@1.2.1` 打包产物中 `allow-same-origin` 出现次数为 **0**，只有 1 处 `allow-scripts`。→ 最终沙箱**仅 allow-scripts，无 same-origin**。
- 仓库注入的 CSP meta（`frame-content.ts`）：`default-src 'self'`；`script-src 'unsafe-inline' 'unsafe-eval'` + cdnjs / esm.sh / jsdelivr / unpkg 四个 CDN；`style-src 'unsafe-inline'`；`img-src 'self' data: blob:` + `basemap.nationalmap.gov`、`upload.wikimedia.org`、`thumb.wikimedia.org`；`connect-src 'self'` + 同样四个 CDN。
- 没有"postMessage 白名单"这种说法式设计，而是逐条校验：resize 消息要求 `e.source === sandbox.iframe.contentWindow && e.data?.type === "__ogui_resize"`，且高度经 `clampReportedHeight` 夹到 **[50, 4000]**，并拒绝 NaN/Infinity。
- 宿主回调只有两个，且都 Zod 校验：`sendPrompt({text})`（`z.string().trim().min(1).max(4000)`）、`openLink({url})`（必须 `https:`，可选由 `NEXT_PUBLIC_OPEN_LINK_ALLOWED_ORIGINS` 限定 origin 白名单）；`window.open(url, "_blank", "noopener,noreferrer")`。
- 文档明确 "The sandbox has no same-origin access to storage or host APIs."

**状态保存与恢复：进程内 checkpoint，且没有跨轮次的 UI 状态同步。**

> "The agent uses `create_deep_agent`, CopilotKit middleware, an Anthropic compatibility middleware, and `BoundedMemorySaver(max_threads=200)`. **The checkpoint store is process memory, not durable shared storage. Restarting or scaling the agent can lose or split conversation state.**" —— docs/architecture.md

> "Both services declare scaling from one to three instances. Agent checkpoints currently live in bounded process memory, and the frontend rate limiter is process-local." —— docs/deployment.md

BYOK 场景下 checkpoint ID 按凭据区分（"BYOK conversations have credential-specific checkpoint IDs"）。生成的 UI 自身状态**不自动同步**给 agent：

> "There is no supported cross-call DOM patch API, and arbitrary iframe control state is not automatically synchronized to the agent."

### 6. 交互式答案与追问

- 通道：iframe 内 `await Websandbox.connection.remote.sendPrompt({ text })`；宿主 handler（`apps/app/src/lib/sandbox/sandbox-functions.ts`）校验后 `window.dispatchEvent(new CustomEvent("opengenui:send-prompt", { detail: request }))`，由 chat bridge **同步 claim**；无 listener 时 reject 并提示 "chat bridge unavailable. Please reload the page and try again."。
- **是显式点击，不是自动。** 原文：

> "A deliberate 'Ask about this scenario' action should include validated current selections in `Websandbox.connection.remote.sendPrompt({ text })`. Ordinary filters and sliders run locally. **Never auto-send messages on load, timers, or input changes.**" —— docs/interactive-answers.md

- 每次追问 = 新的一轮（新 output / 新 snapshot），旧输出保留为独立 artifact，旧 artifact 的本地控件仍可继续操作，但不会被回写。

### 7. 它明确承认的局限与未实现

| 类别 | 原文/事实 |
|---|---|
| 状态持久化 | "The checkpoint store is process memory, not durable shared storage."；`BoundedMemorySaver(max_threads=200)`；扩容/重启会丢或分裂会话；rate limiter 也是 process-local |
| 跨调用改写 | "There is no supported cross-call DOM patch API"；"no cross-call patch API"；"do not assume a cross-call patch API or persist iframe state through rerenders" |
| UI 状态回传 | "arbitrary iframe control state is not automatically synchronized to the agent" |
| 数据真实性 | `query_data` "does not apply its query"，只返回 bundled `db.csv` 全量样本；"There is no built-in live weather or business-data connection"；"Sample numbers are illustrations" |
| 路由本身 | "Routing is a model judgment, not a guarantee of the objectively best visualization"；路由失败即该轮失败，**无静默降级** |
| 地图 | "Basemap tiles do not establish driving routes, traffic, or road closures"；连接线 "explicitly illustrative" |
| 遗留/演示件 | "the login-form schema is a nonfunctional demonstration"；"Legacy todo tools remain in the agent" |
| A2UI 限制 | "It accepts at most 12 columns and 200 rows and rejects mismatched row widths." |
| MCP rail | "The assembler returns HTML text... assembling a document does not display or deploy it."；"does not supply the web app's Websandbox bridge or importmap" |
| 模型可用性 | "a configured model name does not prove availability"；"This repository does not guarantee that every model name works" |
| 内部自评遗留问题 | `.chalk/reviews/.../self.findings.md` 与 `handoff.md`（旧版 `widget-renderer.tsx` 时期）记录 P0：`sandbox="allow-scripts allow-same-origin"` 允许 iframe 访问 `window.parent` 与宿主 cookie；另有 DOM 结构耦合、`MutationObserver` 挂 `document.body`、可访问性缺失、当时"no tests exist for any component" |

一处**文档与实现的现存不一致**：`apps/mcp/README.md` 仍示范消费者用 `<iframe sandbox="allow-scripts allow-same-origin" srcdoc={...} />`。Web 应用主体已不再用 `allow-same-origin`，但 MCP 文档保留了这个较宽的组合。

### 补充事实（对借鉴判断有影响）

1. **`openGenerativeUI` 是 CopilotKit 官方 SDK 能力，不是这个仓库发明的。** 官方文档 [docs.copilotkit.ai/generative-ui/open-generative-ui](https://docs.copilotkit.ai/generative-ui/open-generative-ui)：内置 `OpenGenerativeUIActivityRenderer` 会由 CopilotKitProvider 自动注册，"no extra props needed"，sandbox functions 是官方 prop `openGenerativeUI={{ sandboxFunctions }}`。本仓库注册的是**自定义 renderer**（`renderActivityMessages`），差异化在 design-system CSS / CSP / importmap / Idiomorph 流式预览与再导出成独立 HTML。
2. **线上 demo 确实是 BYOK。** 抓取 https://opengenerativeui.copilotkit.ai/ 首页文本为："Open Intelligent UI… API keys… **Add your OpenAI and Jev API keys to start.** Keys clear when you refresh."
3. **无 release、无 tag**，版本以 `-next.1` 预发布形式引用 CopilotKit 包。
4. **环境网络注意**：本机 `hosts` 把 `github.com`、`raw.githubusercontent.com` 等劫持到 `127.0.0.1`，因此 `web_fetch` 报 "resolves to a non-public IP"、`curl` 报 SSL error 35；但 `api.github.com` 实际可解析可用（GitHub REST API 全程成功）。REST API 匿名额度约 60 次/小时，中途被打满过一次。

---

## 二、我的判断 / 推断（以下均为推断，非原文）

1. **推断：这份仓库目前的真实价值是「参考实现 + 交互契约说明书」，不是可 embed 的产品。** 它自身没有 npm 包名、没有 release，且明确要求你"把 patterns 搬进自己的 app"。它的产物几乎都能在 CopilotKit 官方 SDK 里找到对应能力（第 5 点的 `openGenerativeUI`）。真正稀缺的是它写下来的**契约细节**：字段顺序、CSP 清单、sandbox 属性、显式点击回传、内存 checkpoint 的坦白。
2. **推断：它正在被当作 CopilotKit 的营销旗舰快速迭代。** 创建于 2026-03，2026-10-09 改名并配合官方博客发布，10-12 还在加 telemetry 埋点；同时挂着 42 open issues / 53 open PR。短期活跃度不成问题，但接口层面也在动（`-next.1` 依赖）。
3. **推断：`BoundedMemorySaver` 是刻意的 demo 取舍，不是疏忽。** 文档反复在 README / architecture / deployment 三处自陈这一点，属于"已知并接受"。
4. **推断：Jev 路由是整个方案里最脆弱的一环。** 它把「用什么界面回答」外包给一个外部商用 API，而且刻意不做降级（"no silent fallback"）。对 demo 来说这是诚实；对离线桌面应用来说这是硬阻塞。
5. **推断：`Text / A2UI / OGUI` 三分法不是"判定者"，而是"限选项"。** 真正决定界面的是那个被注入了 "CRITICAL: ... do not substitute another rendering tool" 指令、且渲染工具被中间件裁剪过的回答模型。Jev 只选类型。
6. **推断：桌面教学应用不能直接照搬"生成式页面"作为主路径。** 该仓库自己划的边界是：`query_data` 不真的查数据、没有 live 数据源、地图只是底图。教学场景需要可复现、可评分、可离线，这与"每次生成一份 HTML"天然冲突。

---

## 三、对第三方项目的可借鉴点与不可借鉴点

（假设目标是一个**离线/桌面教学应用**）

### 可借鉴

1. **流式 UI 的参数硬顺序契约。** `initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions`（外加 `initialHeight/placeholderMessages`），既能保证"永不无样式渲染"，又能做出"逐个行为生效"的教学节奏。这套顺序与实现无关，可以独立抄。
2. **CSV（内容安全 + 边界的组合）：** iframe 仅 `allow-scripts`（不要 `allow-same-origin`）；`<meta>` CSP 把 `script-src` / `connect-src` 限制到固定的几个 CDN；`img-src` 只放白名单域名；postMessage 侧**逐条校验 `event.source` + `type` + 数值范围**（这里的 `clampReportedHeight` 夹到 [50,4000] 很实用）。这是可以直接照搬的安全基线。
3. **宿主能力面只开两个、且都 Zod 校验。** `sendPrompt`（长度上限）+ `openLink`（强制 https + 可选 origin 白名单）。教学应用同理：只暴露有限的、可审计的宿主动作。
4. **"显式点击回传 + 数据显式带上"的交互模型。** 绝不自动发消息；用户点 "Ask about this scenario" 时把**当前选择值**拼进 `sendPrompt({text})`。这条规则对教学场景特别合适——它天然产生可记录、可复盘的学习动作。
5. **生成 UI 复用宿主设计系统。** `designSkill` + 注入 design-system CSS + `svg classes` + CSS variables + importmap（three / gsap / d3 / chart.js）——让生成物"像产品的一部分"而不是异类。这是这套方案里最耐用的部分。
6. **原生组件而非万能生成。** `useComponent` / `useRenderTool` / `useDefaultRenderTool` 的分层（可预测任务走原生组件，只有真正自由的图解走生成）值得抄。教学场景的大部分题目其实都能用原生组件覆盖，稳且可测试。
7. **工程习惯：** 明确标注 provenance（`is_sample` / `query_applied` / `source`）、区分"用户输入 / 检索证据 / 计算结果 / 示意假设"、`src/__tests__` 里覆盖流式截断（`process-partial-html`）与渲染契约、把"生成的界面"导出为独立 HTML。

### 不可借鉴

1. **不能把第三方付费路由模型当依赖。** Jev 需要 `TYPESAFE_API_KEY`，按量计费（官网标 $42/十亿输入 token），模型名是滚动的 `jev-latest`，且该仓库刻意不做降级。桌面离线应用无法接受。→ 如果要"呈现路由"，应自己做成本地小分类器或规则 + 置信度阈值。
2. **不能沿用进程内存 checkpoint。** `BoundedMemorySaver(max_threads=200)` + "Restarting or scaling the agent can lose or split conversation state"——对教学应用这是致命的（学生的进度会消失）。必须换持久化存储。
3. **不能指望"跨调用改写"或 iframe 状态自动回流。** 设计上就不存在（`no cross-call patch API`）。教学应用要"保留学生的中间状态"，必须自己在宿主侧建模，而不是靠生成 UI 自留状态。
4. **不要把生成式页面当主交互路径。** 这个仓库自己承认它没有真实数据源、不执行 query、地图只是底图、登录表单是假的。教学内容的正确性不能交给每次现场生成的 HTML。若照搬，请把它降级为"可选的探索性演示"，主路径用原生组件 + 固定内容。
5. **不要照搬它的部署形态。** Next.js 服务端 + 独立 Python FastAPI 服务 + Render 双服务（starter plan 付费、1→3 实例），且 Render 蓝图把 `APP_URL` 指向 `opengenerativeui.copilotkit.ai`。桌面应用不需要这套，也不该背这个运维面。
6. **不要抄 MCP 文档里的 `allow-scripts allow-same-origin`。** 那是本仓库自己旧代码遗留、已被内部评审判为 P0 的写法，Web 主体已经修掉，只有 MCP README 还留着。
7. **不要盲目跟随 `-next.1` 预发布依赖与它自定义的渲染器。** 如果你的目标平台能用 CopilotKit 官方 SDK，直接用官方内置 `OpenGenerativeUIActivityRenderer` + `openGenerativeUI` prop 更省事；抄这个仓库的自定义 renderer 等于同时接管流式、CSP、morph、导出四条链路的维护。而且它那个 `ExplainerCardsPortal` 用 MutationObserver 依赖 CopilotKit 内部 DOM（`welcomeScreen.children[0]`），升级即碎——这类耦合不要学。
8. **不要直接复用它的"三分法"文案。** `Text / Table(A2UI) / OGUI` 的划分是这个 demo 的产物，对教学场景未必贴合（教学更需要"步骤可回放""答案可评分"这类维度）。

---

## 附：一手来源清单

- 仓库：https://github.com/CopilotKit/OpenIntelligentUI
- API 快照：https://api.github.com/repos/CopilotKit/OpenIntelligentUI
- README：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/README.md
- 架构：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/architecture.md
- 呈现路由：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/visualization-routing.md
- 生成式 UI：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/generative-ui.md
- 交互与追问：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/interactive-answers.md
- 部署：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/deployment.md
- 路由实现：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/apps/agent/src/visualization_router.py
- 沙箱桥：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/apps/app/src/lib/sandbox/sandbox-functions.ts
- CSP 与 iframe 内容：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/apps/app/src/components/generative-ui/open-generative-ui/frame-content.ts
- 渲染器：https://github.com/CopilotKit/OpenIntelligentUI/blob/main/apps/app/src/components/generative-ui/open-generative-ui/renderer.tsx
- 官方博客：https://www.copilotkit.ai/blog/introducing-open-intelligent-ui
- 官方 SDK 文档（Open Generative UI）：https://docs.copilotkit.ai/generative-ui/open-generative-ui
- TypeSafe / Jev：https://docs.typesafe.ai/introduction/quickstart · https://typesafe.ai/
- 线上 demo：https://opengenerativeui.copilotkit.ai/
