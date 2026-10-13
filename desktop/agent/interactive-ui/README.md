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

运行 `node desktop/tools/create-interactive-preview.cjs` 会生成可离线打开的 `dist/interactive-components-preview.html`：八张卡片使用正式渲染器，可对比外观。自动化桥接测试使用隔离模拟服务验证调用路径，不宣称真实 DeepSeek/Qwen 已通过教学质量验收。

内置 Skill 附九组完整 few-shot：KMP、快排分区、Attention、Bellman、完整快排、堆排序、二次函数、二维线性变换、完整 KMP；通过协议与交互检查。它们是组件组合与教学边界的示范，不是所有算法的固定模板。


## 完整代码执行（优先增补阶段）

新增 `mode: "algorithm"`：字段为 `{schemaVersion:1, mode:"algorithm", algorithm:"quicksort-lomuto-v1", title, question, source:{kind:"illustrative",label}, input:[整数...]}`。模型无需也不能提交代码或轨迹。`desktop/web/quicksort-trace.mjs` 作为前后端共享的版本固定核心；构建时同时复制到便携包 `web/` 供 Agent 协议校验使用。

状态为 `{step, input}`，保存用户改动后的数组和进度；数组允许空数组、重复值及负数，最多12项且每项在[-999,999]。步骤上限按该数组的确定性轨迹计算。完整轨迹按当前固定代码重新计算，包含每次条件比较、原位/实际交换、分区返回和所有递归。显示代码为 Lomuto 末尾枢轴、严格小于、左侧先递归；不接受任意代码，不把此演示冒充其他快排实现。

`algorithm-player.js` 提供代码高亮、数组、变量、调用栈、前后步进、进度滑块、自动播放/暂停、调速、重置和输入重算。折叠卡片暂停播放，切走页面或移除组件后停止计时；播放状态与速度不持久化，避免恢复历史时自行播放。截图与离线组合预览使用同一渲染器。原单次分区组件样例仍保留以兼容旧作品；组合预览现改为完整快排播放器。Skill 增加完整算法模式 few-shot，原四组组件 few-shot 保留用于局部概念讲解。

## 树形算法与数学交互

`execution-traces.mjs` 注册固定算法版本。新增 `heapsort-max-v1`：自底向上建大顶堆，然后取最大值到尾部并下沉；完整轨迹与代码行对应，树节点索引对应数组索引，只绘制有效堆前缀。输入和进度保存规则与快排相同。

新增 `mode: "math"`，严格字段 `{schemaVersion:1,mode:"math",math,title,question,source:{kind:"illustrative",label},initialState}`；不允许代码或表达式。`quadratic-v1` 初始/保存状态为 `{a,h,k,x}`，范围分别为 [-3,3]、[-4,4]、[-4,4]、[-5,5]；绘制 y=a(x-h)²+k、顶点和探查点切线。a=0 是常数函数。坐标图会裁切视窗外曲线。

`linear-transform-2d-v1` 状态为 `{a,b,c,d,vx,vy,t}`，前六项 [-3,3]，t 在 [0,1]；按行排列矩阵，等比例坐标展示 B(t)=(1-t)I+tA 的网格、基向量、单位面积与向量，明确区分目标 det A 和当前 det B(t)。插值中间可能奇异；面积缩放为行列式绝对值。

`math-models.mjs` 是前后端共用计算和状态校验核心，`math-explorer.js` 是正式渲染器。控制变化仅在本地计算，释放/确认后保存，不请求模型。三个新模式接入角色开关与内置 Skill。验收使用隔离数据与模拟模型；真实模型选择参数和解释的质量仍待验收。

## 完整 KMP 代码执行

`kmp-prefix-first-v1` 同属 `mode: algorithm`，input 为 `{text,pattern}`，状态为 `{step,input:{text,pattern}}`；文本最多48个 UTF-16 基本多文种字符，模式最多24个，不接受控制字符、代理码元或 emoji。不裁剪输入，空格保留并绘为 ␠。代码先构建 pi 前缀表，再寻找首个匹配；索引从0开始，不存在返回-1，空模式返回0。它不是 next[0]=-1 / nextval 的实现，不支持任意用户源码。

复用算法播放器，`kmp-view.js` 提供两阶段字符对齐、i/j 指针、未知/已知 pi 表和结果；失配回退不移动文本 i。未计算前缀项显示问号。用户可以修改字符串并重算，输入和进度保存恢复，控件不会调用模型。`kmp-trace.mjs` 为前后端共享的版本固定核心，便携构建复制同一模块。

`kmp.test.mjs` 对965组输入逐次比较展示源码的真实运行、回退、pi写入；另以原生 indexOf 和独立暴力前后缀枚举验证结果。浏览器覆盖每步代码行/pi、鼠标键盘触屏、中文、空串与360px长字符串；隔离桌面用模拟模型验证生成工具和修改输入后的历史恢复，不代表实际 DeepSeek/Qwen 教学质量通过。

## 自定义作品与独立审核（SDK v1）

新增 `mode: custom`：schemaVersion/sdkVersion/stateVersion均为1；文档含title、question、source、stateSchema、initialState、script、checks，文档上限64KiB、脚本48000字符。状态最多16键，支持有界数字、布尔、枚举、有界数字数组；协议见 `desktop/web/custom-contract.mjs`，生成写法见 `desktop/agent/skills/interactive-explanation/SDK.md`。

模型用 `Reed.register({render,reduce})` 编写新计算和新SVG视图，复用可信按钮、滑块、输入、选择、可拖动点和布局。每次操作新建Worker，返回结果后即终止；超时1500ms强制终止；Worker无DOM、Tauri、网络、导入和定时器。必须通过声明状态恢复，不能依赖闭包。可信opaque iframe仅渲染校验过的UI树，sandbox仅allow-scripts，CSP限制连接和资源；来源窗口和随机nonce验证消息。卸载/折叠清理，重开恢复参数。不是任意HTML/React执行环境，不提供动画tick、Canvas/WebGL；也不宣称Worker提供操作系统级内存硬配额。

生成入口先解析、校验，再使用独立Edge真实试运行初始UI和最多6个声明操作，失败不发布；这些操作不构成教学事实证明。同一用户请求最多3次生成尝试，修复反馈包含stage、message、next和剩余次数。get_interactive_reference只返回打包SDK、从实际校验注册表导出的catalog、3份完整源码示例（gradient、queue、policy）和修复指导。原9份JSON few-shot保留。独立实验服务不参与生产运行。

模型设置页可选“自定义交互作品·独立审核”，默认关闭，复用已配置提供商、模型和思考档位。开启即发送该作品源码、题目和试运行状态到所选服务；不发API Key或完整聊天，也不切换聊天模型。审核是文本/源码审核，当前不传截图；失败、要求修正、截断或超时不发布。用户不必设置maxTokens，SDK沿用模型配置/默认；审核通过仍记录facts:unverified，不冒充事实认证。取消生成不发布。

离线预览现为11张卡片：原8张加3个自定义例子。离线file预览嵌入可信frame bundle，生产加载打包frame；模型源码仍仅进入Worker。新增定向验收 `custom.test.mjs`、`custom-browser.cjs`、`custom-desktop.cjs`。用户要求开发阶段不反复全量测试，后续接近整体完成再统一大验收。真实本地/云端模型陌生题质量仍待验证。
