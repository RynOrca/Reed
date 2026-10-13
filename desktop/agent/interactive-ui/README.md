# Reed 原生交互作品协议（阶段 2）

`schemaVersion: 1, mode: "components"` 的文档由 `protocol.mjs` 校验、`desktop/web/interactive-components.js` 渲染。文档是纯 JSON；组件只读文档和有界整数状态，文字一律写入 DOM `textContent`。当前只开放 `source.kind: "illustrative"` 的固定教学样例；模型生成入口和角色门控属于阶段 3。

顶层字段：`title`、`question`、`source: {kind,label}`、`stateSchema: {状态名:{min,max}}`、`initialState`、`nodes`。状态名和节点 ID 只允许小写 ASCII、数字、下划线、短横线；所有初始/保存状态必须恰好覆盖声明的状态键。最多 8 个状态、24 个组件、32 KiB UTF-8 文档；状态范围至多 20 个整数档。多余字段、未知组件、HTML/JS/CSS/表达式均拒绝。参数细则以 `protocol.mjs` 为准。

可用组件：

| 类型 | 主要参数 | 行为 |
| --- | --- | --- |
| `StringTracks` | `text`, `pattern`, `offsetState`, `knownByState` | 字符逐格对齐；按状态显示真正已知的前缀长度 |
| `ArrayTrack` | `values`, `highlightState`, `pivotIndex` | 数组轨道与枢轴、左侧高亮 |
| `Pointer` | `label`, `index` 或 `indexState` | 指针标记 |
| `HighlightRange` | `label`, `start`/`startState`, `end`/`endState` | 文字说明的已知范围 |
| `NodeGraph` | `nodes`, `edges`, `activeState` | 有界节点与带标签的关系 |
| `Plot` | `max`, `values` 或 `variantState` + `valuesByState` | 随状态变化的数值条形图 |
| `DiscreteSlider` | `state`, `label`, `labels` | 原生 range，支持键盘、鼠标、触屏 |
| `DragHandle` | `state`, `choices`, `label` | 自定义拖动柄，支持方向键、Home/End、鼠标和触屏 |
| `ChoiceFeedback` | `state`, `cases` | 按当前选择展示解释，可标出正确选项 |
| `StageReveal` | `state`, `equals`, `title`, `body` | 达到指定状态后揭示说明 |
| `Reset` | `label` | 恢复 `initialState` |

固定样例在 `fixtures.mjs`：KMP 对齐、快排分区、Attention 温度与 Bellman 单步目标。`create_interactive_fixture` 只在 `SUMMON_INTERACTIVE_UI_TEST=1` 的隔离测试进程可调用。作品仍通过阶段 1 的消息 ID 绑定、独立文件、版本父链与对话卡片展示；用户操作只保存声明的状态，不触发模型请求或教学掌握度记录。

验收：`npm test` 覆盖协议、样例事实和跨进程恢复；`desktop/tools/interactive-ui-browser.cjs` 覆盖四样例的键盘、鼠标、触屏、窄屏、重置和卡片重建；`npm run test:desktop` 在隔离便携包中验证真实 Reed 卡片保存与会话重开。
