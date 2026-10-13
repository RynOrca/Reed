# Reed 原生交互作品协议（阶段 2）

`schemaVersion: 1, mode: "components"` 的文档由 `protocol.mjs` 校验、`desktop/web/interactive-components.js` 渲染。文档是纯 JSON；组件只读文档和有界整数状态，文字一律写入 DOM `textContent`。只开放 `source.kind: "illustrative"` 的教学示例；角色开启 `interactiveUiEnabled` 后可调用模型生成工具，关闭时工具不注册。

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


## 第三阶段：角色开关与内置 Skill

`generation.mjs` 自动加载发布包中的 `skills/interactive-explanation/SKILL.md`，仅对已开启角色注入；不会占用用户自行绑定的技能槽。此 Skill 是版本管理的内置能力说明，不依赖用户技能仓库副本。工具 `generate_learning_ui` 接收 `{document: JSON字符串, parentArtifactId?: UUID}`。模型负责选择组件和计算每档数据，程序负责严格协议校验、原生渲染与保存；没有任意代码执行。校验失败返回模型修正，不保存半成品。父作品必须属于当前分支。

作品绑定到含相应 toolCall ID 的助手消息；成功后发 `interactive_artifact` 事件，前端即时追加卡片，重开会话按同一绑定恢复。关闭开关后仍能操作历史卡片，但不能生成新作品。

运行 `node desktop/tools/create-interactive-preview.cjs` 会生成可离线打开的 `dist/interactive-components-preview.html`：七张卡片使用正式渲染器，可对比外观。自动化桥接测试使用隔离模拟服务验证调用路径，不宣称真实 DeepSeek/Qwen 已通过教学质量验收。

内置 Skill 附八组完整 few-shot：KMP、快排分区、Attention、Bellman、完整快排、堆排序、二次函数、二维线性变换；通过协议与交互检查。它们是组件组合与教学边界的示范，不是所有算法的固定模板。


## 完整代码执行（优先增补阶段）

新增 `mode: "algorithm"`：字段为 `{schemaVersion:1, mode:"algorithm", algorithm:"quicksort-lomuto-v1", title, question, source:{kind:"illustrative",label}, input:[整数...]}`。模型无需也不能提交代码或轨迹。`desktop/web/quicksort-trace.mjs` 作为前后端共享的版本固定核心；构建时同时复制到便携包 `web/` 供 Agent 协议校验使用。

状态为 `{step, input}`，保存用户改动后的数组和进度；数组允许空数组、重复值及负数，最多12项且每项在[-999,999]。步骤上限按该数组的确定性轨迹计算。完整轨迹按当前固定代码重新计算，包含每次条件比较、原位/实际交换、分区返回和所有递归。显示代码为 Lomuto 末尾枢轴、严格小于、左侧先递归；不接受任意代码，不把此演示冒充其他快排实现。

`algorithm-player.js` 提供代码高亮、数组、变量、调用栈、前后步进、进度滑块、自动播放/暂停、调速、重置和输入重算。折叠卡片暂停播放，切走页面或移除组件后停止计时；播放状态与速度不持久化，避免恢复历史时自行播放。截图与离线组合预览使用同一渲染器。原单次分区组件样例仍保留以兼容旧作品；组合预览现改为完整快排播放器。Skill 增加完整算法模式 few-shot，原四组组件 few-shot 保留用于局部概念讲解。

## 树形算法与数学交互

`execution-traces.mjs` 注册固定算法版本。新增 `heapsort-max-v1`：自底向上建大顶堆，然后取最大值到尾部并下沉；完整轨迹与代码行对应，树节点索引对应数组索引，只绘制有效堆前缀。输入和进度保存规则与快排相同。

新增 `mode: "math"`，严格字段 `{schemaVersion:1,mode:"math",math,title,question,source:{kind:"illustrative",label},initialState}`；不允许代码或表达式。`quadratic-v1` 初始/保存状态为 `{a,h,k,x}`，范围分别为 [-3,3]、[-4,4]、[-4,4]、[-5,5]；绘制 y=a(x-h)²+k、顶点和探查点切线。a=0 是常数函数。坐标图会裁切视窗外曲线。

`linear-transform-2d-v1` 状态为 `{a,b,c,d,vx,vy,t}`，前六项 [-3,3]，t 在 [0,1]；按行排列矩阵，等比例坐标展示 B(t)=(1-t)I+tA 的网格、基向量、单位面积与向量，明确区分目标 det A 和当前 det B(t)。插值中间可能奇异；面积缩放为行列式绝对值。

`math-models.mjs` 是前后端共用计算和状态校验核心，`math-explorer.js` 是正式渲染器。控制变化仅在本地计算，释放/确认后保存，不请求模型。三个新模式接入角色开关与内置 Skill。验收使用隔离数据与模拟模型；真实模型选择参数和解释的质量仍待验收。
