> 2026-10-13 已确认调整：采用每个角色的 `interactiveUiEnabled` 开关，默认 false。启用时自动加载 `desktop/agent/skills/interactive-explanation/SKILL.md` 并注册 `generate_learning_ui`；关闭时既不注册工具也不注入 Skill，执行入口再校验权限。其他角色原则与已绑定技能保持有效。无需新增内置角色。组件 JSON 由工具持久化并绑定工具调用所属助手消息，实时显示卡片，历史沿用同一作品。Skill 是生成指导，后端是权限和格式边界，格式通过不等于教学事实正确。

# Reed 交互讲解能力与作品系统实施方案

状态：第 1–2 阶段完成，第 3 阶段完成（96 项 Agent 测试、38 项隔离桌面检查通过）；第 4–5 阶段待实现。日期：2026-10-13。适用基线：Reed 0.2.0，第三阶段基线 Git `d46293f`。本文件是交接给下一位开发者的实施规格；实施时以当前代码为准，若接口变化，先更新本文件再改代码。

## 1. 产品边界与验收目标

在角色编辑中提供「允许生成交互讲解」开关（`interactiveUiEnabled`，默认 false）。任何内置或自定义角色都可启用；开启时模型获得内置 Skill 和生成工具，也可选择纯文字回答。关闭时不注册工具、不注入 Skill，工具执行入口再次检查权限。已生成的作品在任何角色下仍可查看。移除内置 Planner，旧配置选中它时回退 Agent；不新增交互专用角色。

面向用户的入口仍是 Reed 的对话：提问后，助手消息中出现“交互讲解作品”卡片，包含标题、一句操作引导、生成状态、展开/收起、重置和“围绕当前选择追问”。窄窗口卡片可展开为对话内宽视图；不要把生成内容塞入 Markdown 或另开浏览器。允许同一轮回复同时有短文字和一个作品。每个作品是不可覆盖的版本，追问生成新作品；旧作品继续可交互。用户手动操作后的当前状态须在会话关闭重开后恢复。

成功标准是学习者通过操作得到一个问题的解释，而非仅有可点击控件。先验证 KMP 失配位置、快排一次分区、Attention 权重变化、Bellman/价值更新四类任务；普通提问、表达含糊和模型能力不足时保持清楚的文字回复。

## 2. 可借鉴的 OpenIntelligentUI 部分

官方仓库：[OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI)；[架构](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/architecture.md)、[呈现路由](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/visualization-routing.md)、[作品与追问](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/interactive-answers.md)。其做法是按问题选择文字、原生组件或隔离生成页面；生成作品在聊天中展示，沙箱内局部操作，主动追问才把选择传给 Agent；后续生成新快照。Reed 借鉴这套职责分离和交互约定。仓库使用 Next.js/CopilotKit/Python Agent/Jev 路由，Reed 当前是 Tauri WebView + PI Node Agent，第一版不替换运行栈，也不要求另一个付费路由模型。仓库的进程内检查点不是持久会话方案，Reed 应使用自己的会话与作品存储。

## 3. 现有代码与拟改动位置

| 现有位置 | 已有能力 | 实施任务 |
| --- | --- | --- |
| `desktop/agent/roles.mjs` | 内置角色、用户编辑与持久化 | 增加能力布尔字段并兼容旧配置（默认关闭）；保留用户角色修改；移除 Planner 并回退旧选中值。 |
| `desktop/agent/bridge.mjs` | PI 会话、工具、事件、历史、角色切换 | 仅对已开启角色注册/开放生成工具；接收工具产物、关联本轮助手消息、发作品事件、恢复历史；中断/错误不发布半成品。 |
| `desktop/agent/interactive-ui/generation.mjs`、`desktop/agent/skills/interactive-explanation/SKILL.md` | 每轮角色上下文、教学流程 | 添加交互讲解契约：从具体困惑设计一次操作；不自动宣称掌握；缺少数据时提问或标明示例。 |
| `desktop/web/app.js`、`index.html`、`style.css` | 对话气泡、流式状态和历史重建 | 作品卡片、组件渲染入口、展开布局、状态与错误展示；历史恢复时按消息 ID 插入卡片。 |
| `desktop/web/markdown.js` | 安全渲染文字、原始 HTML 作为文本 | 保持原行为；作品走独立的结构化事件，不解析回答中的 HTML 为界面。 |
| `experiments/intelligent-ui-lab/` | 模型连接、HTML 生成和隔离预览实验 | 作为模型能力与 iframe 策略的测试参考；生产实现不得依赖 8765 服务。 |

新增建议：`desktop/agent/interactive-ui/` 放协议、校验、存储与工具；`desktop/web/interactive-ui/` 放卡片、组件和沙箱渲染。具体文件名可按现有模块风格调整。

## 4. 端到端协议与消息关联

### 4.1 生成路由

角色系统说明要求先判断交互是否真正有用。第一版由当前回答模型直接决定调用 `generate_learning_ui` 或给文字，无单独 Jev 服务。工具是能力开关控制的 `customTool`，后端仍需检查 `roles.current().interactiveUiEnabled === true`；不依赖模型遵守提示词。传入一个版本化、大小有上限的 JSON 文档。生成超时、截断、解析失败或校验失败时显示明确原因，保留文字回答；不把部分 JSON 当成功作品，宿主不自行发起重试；模型可依据错误反馈最多修正两次（Skill 约定），仍失败则回到文字。

### 4.2 作品格式 v1

模型主要生成教学设计与数据，Reed 负责组件行为。下例仅示意字段，当前由 `protocol.mjs` 严格校验字段、节点数、文本长度及整数范围，嵌套结构只接受组件白名单中的有限层级：

```json
{
  "schemaVersion": 1,
  "mode": "components",
  "title": "KMP 为什么能跳过重比？",
  "question": "失配后，试着选择下一个可能的起点。",
  "source": {"kind": "illustrative", "label": "教学示例"},
  "stateSchema": {"offset": {"min": 0, "max": 2}},
  "initialState": {"offset": 0},
  "nodes": [
    {"id": "alignment", "type": "StringTracks", "props": {"text": "ABABABC", "pattern": "ABABC", "offsetState": "offset", "knownByState": {"0": 4, "1": 0, "2": 2}}},
    {"id": "offset", "type": "DiscreteSlider", "props": {"state": "offset", "label": "右移格数", "labels": ["原位", "1格", "2格"]}},
    {"id": "check", "type": "ChoiceFeedback", "props": {"state": "offset", "cases": [{"value": 0, "reason": "T[4]=A 与 P[4]=C 失配"}, {"value": 1, "reason": "T[1]=B 与 P[0]=A 矛盾"}, {"value": 2, "reason": "T[2..3]=AB 与 P[0..1]=AB 可复用"}]}}
  ]
}
```

组件库第一批提供 `StringTracks`、`ArrayTrack`、`Pointer`、`HighlightRange`、`NodeGraph`、`Plot`、`DiscreteSlider`、`DragHandle`、`ChoiceFeedback`、`StageReveal`、`Reset`。每个组件有固定 props schema、键盘与触屏操作、窄屏布局、减少动画偏好和空/错误状态。拖动、滑块、重置等通用行为由 Reed 实现；模型不能在组件协议中注入 JS、HTML、CSS、函数名或任意表达式。条件与状态变更采用有限枚举动作（设置值、提交选择、进入阶段、重置），所有引用须指向已声明状态与节点。原生组件使用 DOM `textContent` 填充模型文字。

复杂任务可用第二种 `mode: sandboxHtml`：模型提交自包含 HTML/CSS/JS，Reed 用独立 iframe 渲染。只在组件协议无法表达所需交互时选择。沙箱不含 Tauri API、文件权限、同源存储或网络；具体 `sandbox` 属性与 CSP 在 WebView2 上实测确定。与宿主的 `postMessage` 桥仅接受版本化、白名单消息，例如显式点击后的 `askAboutSelection` 和有界高度通知；验证来源窗口、实例 nonce、作品 ID、负载结构和大小。普通控件变化不自动向模型发请求。不能为实现效果放宽主 WebView 权限。

### 4.3 保存与恢复

作品文件放在 Reed 用户数据目录下的 `artifacts/interactive/<sessionId>/<artifactId>.json`，当前含已校验文档、时间、ID、父作品 ID 与有界操作状态；模型来源与分层质量标签留待教学验收阶段完善，不含 API Key 或思考全文；原子写入。作品 ID 使用随机值，不从模型文本导出路径。PI 会话分支追加一条自定义记录，绑定 `assistantMessageEntryId` 与 `artifactId`；生成工具执行时匹配包含该 toolCall ID 的已落盘助手消息并立即建立关联；最终文字回复可以继续生成。`history` 事件返回轻量作品元数据，前端按 ID 请求正文。会话切换和分支历史只展示当前分支已关联的作品；文件缺失时保留卡片并显示“作品文件不可用”，不要吞掉聊天文本。删除会话的作品清理由现有删除流程扩展，遵守二次确认。

组件作品的本地状态以允许的状态键和值保存，拖动或滑块释放后串行、原子写入；重新进入恢复并校验，协议版本不兼容时回到初始状态并提示。沙箱页面的任意 DOM 状态无法可靠序列化：第一版只保存显式上报、经过校验的关键选择；其他局部动画/滚动状态重开时重置，并在产品上说明。追问创建新作品快照，不修改旧作品源文件。用户主动点击“问 Reed”时，宿主把有限的当前选择转成可见的用户消息；不能悄悄写入教学记忆或自称完成测验。

## 5. 教学正确性与模型适配

验收分三层：① 协议/安全/资源校验；② 渲染与控件冒烟检查（初始、错误选择、正确选择、重置、窄屏）；③ 主题事实校验。KMP 的前缀函数、对齐和下一比较索引，以及排序的数组置换可用独立算法判定；Attention/Bellman 需明示公式、参数、数值容差和示例来源。无法自动判定的概念解释显示为“待核对”，不标记为已验证。失败原因可供用户主动要求修正，不自动静默修补。质量标签区分“结构通过”“交互通过”“事实通过/待核对”；不得宣称用户已掌握。

模型兼容沿用 Reed 现有 Provider、Model ID、Key 和思考档位配置。组件协议的 schema 与示例应适合本地小模型；不假设模型支持原生结构化输出、工具调用或固定思考参数。实现时验证 PI customTool 对配置模型的实际支持；若模型不能稳定调用工具，后续可在**已开启此能力的角色内**提供显式“生成交互作品”动作，经同一 provider 发受限 JSON 请求并走完全相同的校验/存储路径，不能让未开启的角色自动触发。对每个候选模型记录生成成功率、教学错误、耗时、token、修正次数；独立试验仅证明 DeepSeek 在详细提示下能做出一个 KMP 小实验，不能据此保证本地模型表现。

## 6. 分阶段实施顺序与完成门槛

1. **持久作品与聊天卡片。** 用固定测试作品打通消息关联、展开、版本、历史恢复、删除与缺失文件；模拟数据不触碰真实会话。完成门槛：重启 Reed 后旧卡片仍可用，普通消息与其他角色路径不变。
2. **原生组件库。** 先实现字符/数组轨道、指针、高亮、滑块、选择反馈、阶段与重置；再按四个验收主题补图/数值积木。完成门槛：固定样例在键盘、鼠标、窄屏下状态一致，返回历史能恢复选择。
3. **角色与模型生成。** 角色开关、内置 Skill（含四份通过协议和交互检查的 few-shot）、生成工具门控、协议校验和失败反馈。完成门槛：已开启角色能选文字或作品；关闭后工具与 Skill 消失，伪造调用被后端拒绝；真实桥接与桌面链路可恢复作品。当前要求模型支持工具调用；不支持工具调用模型的显式生成动作仍待后续实现。
4. **自定义沙箱与主动追问。** 接入有边界的 HTML 回退和白名单桥。完成门槛：iframe 无法读写宿主/文件/网络；明确点击才启动下一轮；旧快照仍可操作。
5. **教学验收与模型矩阵。** 四类主题各覆盖正确路径、错误预测、边界例和修正；用实际本地小模型及 DeepSeek/Qwen 记录数据。完成门槛：错误作品不被标成“可靠”，生成失败可回到文字；用户可按真实体验决定是否继续扩展组件库。

每阶段完成后执行对应 Node 单元/集成测试与桌面验收，更新 `PLAN.md`、`CHANGELOG.md`，单独提交。启动新的 Node 进程前按项目规则检查同项目现有进程并先询问是否关闭。生产代码变更后重启服务端/桌面进程再做真实验收。模型调用不得使用生产数据测试破坏性 API。

第 2 阶段实际协议与组件参数见 [`desktop/agent/interactive-ui/README.md`](desktop/agent/interactive-ui/README.md)。固定作品现在使用 `mode: components`；旧 `mode: fixture` 仍可读取，保证第 1 阶段作品兼容。组件状态只接受声明的整数键，绘制与交互均由 Reed 实现，模型生成入口现由角色开关控制。

## 6.1 优先增补：完整算法代码执行（2026-10-13 已完成）

在 HTML 回退之前，先把完整快排执行做扎实。不能用静态 ArrayTrack + 分界滑块替代算法全程。新增固定版本 `quicksort-lomuto-v1` 的确定性轨迹：末尾枢轴、严格小于、先左后右递归；显示实际对应代码、数组、变量、栈和每步解释。模型使用 `mode: algorithm` 指定输入，不生成执行代码或编造轨迹。用户提供其他版本代码时必须说明差别，当前不支持任意源码执行。

前端支持前后步进、进度定位、播放/暂停、速度、重置与输入重算；输入和当前步骤保存为作品状态。轨迹引擎版本固定，前后端共用同一模块。验收将每次交换与比较对照展示源码的真实运行，并覆盖重复值、负数、空数组、单元素、已排序、逆序及递归结束。通过后以 KMP 和堆排序检查执行视图的可复用性，后续再考虑自由代码执行与 HTML 回退。

## 7. 明确暂缓项

第一版不实现实时跨作品 DOM 补丁、自动判定学习掌握度、把全部算法预制成专用组件、后台定时生成、自动上传作品或更换 Reed 的 Agent 框架。角色仅负责启用这条能力，作品通道负责可见、可恢复与可验证。
