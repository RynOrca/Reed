# Reed 交互作品实现事实清单（只读审计）

日期：2026-10-13。性质：只读代码审计结果，未修改文件、未运行测试。
基线：Reed `2d87ed7`。用途：作为 [INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md](INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md) 的事实依据，以及后续开发的接口事實表。
标注：**【实现】**=代码里确实存在；**【仅文档】**=文档声称但代码没有；**【偏差】**=文档与代码不一致。

---

## 0. 五种 mode 总览

| mode | 谁能创建 | 静态校验 | 试运行 | 审核 | 渲染器 |
| --- | --- | --- | --- | --- | --- |
| components | 模型工具 | protocol.mjs:50-128 | 无 | 无 | interactive-components.js |
| algorithm | 模型工具 | protocol.mjs:36-40 | 无 | 无 | algorithm-player.js |
| math | 模型工具 | protocol.mjs:41-44 | 无 | 无 | math-explorer.js |
| custom | 模型工具 | protocol.mjs:35 + custom-contract.mjs:22-53 | **有**（真实 headless Edge）custom-validation.mjs:9-26 | 可选 LLM | custom-sandbox.js + sandboxed iframe |
| fixture | 仅环境变量门控的测试命令 | protocol.mjs:45-49 | 无 | 无 | interactive-ui.js:59-75 |

模型生成入口只接受 4 种 mode（generation.mjs:50）；`fixture` 只能经 `create_interactive_fixture` 创建，且要求 `SUMMON_INTERACTIVE_UI_TEST=1`（bridge.mjs:335-347）。

---

## 1. 上限与校验严格程度

- 文档上限：custom **65536 字节**，其余 **32768 字节**，按 `Buffer.byteLength(...,'utf8')` 判定（protocol.mjs:34）。
- `title` ≤120、`question` ≤300、`source` 只能是 `{kind:'illustrative',label≤80}`。
- 未知字段一律拒绝，但实现是「键 ⊆ 白名单」，**不是**「必须全部出现」（protocol.mjs:6；custom-contract.mjs:2）；custom 顶层字段是例外，必须齐全（custom-contract.mjs:23）。
- **components**：stateSchema 1–8 键，`min≥-100`、`max≤100`、`max-min≤20`；nodes 2–24；11 类组件各有独立参数上限（protocol.mjs:54-127）。
- **algorithm**：引擎白名单仅 `quicksort-lomuto-v1`、`heapsort-max-v1`、`kmp-prefix-first-v1`（execution-traces.mjs:5-9）；排序输入 0–12 个 [-999,999]；KMP `{text≤48,pattern≤24}`，禁控制字符与代理码元；状态恰为 `{step,input}`。
- **math**：仅 `quadratic-v1`（`a[-3,3],h[-4,4],k[-4,4],x[-5,5]`）与 `linear-transform-2d-v1`（6 项 [-3,3]，`t∈[0,1]`）（math-models.mjs:2-3）。
- **custom**：script ≤48000 字符；stateSchema ≤16 键；checks ≤6 个；UI 树 ≤500 节点、深度 ≤12、序列化 ≤100000 字符。

---

## 2. custom 契约

### 2.1 脚本与生命周期【实现】

- 入口 `Reed.register({render, reduce})`：两者必须是函数，否则抛错；同一 Worker 内二次注册抛「只能注册一次」（custom-frame-source.mjs:14）。因每次操作新建 Worker，实际等价于「每个 Worker 注册一次」。
- 宿主调用顺序：`reduce(structuredClone(state), action)` → `render(structuredClone(返回的 next))`（custom-frame-source.mjs:15）。render 拿到的是 reduce 返回值的深拷贝。
- 初始渲染 `event` 为 `null`，Worker 直接 `next = state` 后 render。
- `reduce` 返回值先过 `validCustomState`，UI 树先过 `validCustomTree`，任一不合法即报「返回状态或 UI 树不符合 SDK 协议」并终止（custom-frame-source.mjs:63）。
- 禁止依赖闭包/全局跨操作保存（每次操作新 Worker）。
- `ui` 与 `Reed` 用 `Object.freeze` + `defineProperty(writable:false,configurable:false)` 锁定（custom-frame-source.mjs:13-14）。

### 2.2 SDK 原语完整列表【实现】

3 个专用构造函数 + 12 个「透传 props」工厂（custom-frame-source.mjs:11-12）。字段为精确白名单，可省略但不可多。

| 原语 | 允许字段 | 事件 value |
| --- | --- | --- |
| `ui.text(v)` | `text`(≤1000) | — |
| `ui.column(arr)` / `ui.row(arr)` | `children` | — |
| `ui.button({...})` | `label,action`（必填） | `undefined` |
| `ui.slider({...})` / `ui.number({...})` | `label,value,min,max,step,action`（必填；`value∈[min,max]`，`step∈[1e-6,1e6]`） | `Number` |
| `ui.select({...})` | `label,value,options,action`；options 1–20 个字符串(≤80)，`value∈options` | 字符串 |
| `ui.svg({...})` | `viewBox`(4 个有限数，宽高>0), `children` | — |
| `ui.line({...})` | `x1,y1,x2,y2,stroke,strokeWidth` | — |
| `ui.path({...})` | `d`(≤12000), `stroke,strokeWidth,fill` | — |
| `ui.circle({...})` | `cx,cy,r,stroke,strokeWidth,fill` | — |
| `ui.rect({...})` | `x,y,width,height,stroke,strokeWidth,fill` | — |
| `ui.polygon({...})` | `points`(≤12000), `stroke,strokeWidth,fill` | — |
| `ui.label({...})` | `x,y,text,fill` | — |
| `ui.point({...})` | `cx,cy,r,fill,action,minX,maxX,minY,maxY`；带 action 才可拖 | `{x,y}` |

- 图形节点只能出现在 `svg.children` 内（custom-contract.mjs:36-37）。
- 数值统一 `finite(-1e6,1e6)`（custom-contract.mjs:44）。
- 颜色只有 9 种：`none`、`#8dcaf0`、`#8dceb0`、`#efbd72`、`#ee9797`、`#ecf4ff`、`#536b84`、`#16283b`、`#37779d`。
- **不存在**：文本输入框（只有 range/number 与 select）、样式/class、事件回调函数、`innerHTML`、URL、任意 SVG 元素、模板字符串注入。
- `ui.point` 交互：`pointerdown`/`pointerup`/`pointercancel` + 方向键（每次 1 坐标单位），**没有 `pointermove` 拖动预览**；坐标 clamp 在 `[minX,maxX]×[minY,maxY]`（custom-frame-source.mjs:44-51）；`tabindex=0`、`role=button`、有 `aria-label`。

---

## 3. 隔离实现【实现】

- **Worker**：`new Worker(URL.createObjectURL(new Blob(["'use strict';(<workerBoot>)();\n", doc.script])))`，随后立即 `revokeObjectURL`（custom-frame-source.mjs:57-58）。模型脚本与 bootstrap 同处一个**经典（非 module）** Worker。
- **生命周期**：每次操作 `start()` 先 `stop()`；收到合法回复后 `stop()`；`stop()` = `clearTimeout` + `terminate()`。`pending` 未决时 `request()` 返回 false，同一时刻只有一次计算。
- **超时**：单次计算 **1500ms**（custom-frame-source.mjs:20）；frame→parent 启动超时 **7000ms**（custom-sandbox.js:14）；单次 `runAction` **2500ms**（custom-sandbox.js:26）。
- **消息上限**：frame 累计 **5000 条**后**静默丢弃一切后续消息**（含 action，custom-frame-source.mjs:73），前端只表现为 2500ms 超时。
- **置空的全局**：`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`importScripts`、`Worker`、`SharedWorker`、`indexedDB`、`caches`、`setTimeout`、`setInterval`（custom-frame-source.mjs:10）。
- **iframe**：`sandbox="allow-scripts"`（**无 `allow-same-origin`**，即 opaque origin）、`referrerPolicy="no-referrer"`（custom-sandbox.js:5）；离线 `file:` 预览改用 `srcdoc`。
- **生产 CSP**（custom-frame.html:2）：`default-src 'none'; script-src 'nonce-reed-frame-v1' blob:; worker-src blob:; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。nonce 是**写死的固定串** `reed-frame-v1`。
- **消息白名单**：parent→frame 为 `init|pause|resume|reset|action`（`action` 要求 string 且 `JSON.stringify(value??null).length≤2048`）；frame→parent 为 `render|error|reset`。
- **校验**：frame 侧要求 `e.source===parent`、`data.reedCustom===1`，首个消息必须是带 nonce 的 `init` 且通过文档与状态校验；绑定后所有消息必须 nonce 匹配。parent 侧要求 `e.source===frame.contentWindow`、`reedCustom===1`、nonce 匹配，且 `render`/`reset` 的 state 与 tree 再跑一次校验。两方向都 `postMessage(...,'*')`，不依赖 origin，靠 opaque origin + source 身份 + nonce。
- **卸载**：MutationObserver 检测卡片脱离文档即 `dispose()`；折叠时 `pause`。
- **试运行**：`validateCustomRuntime` 先用 `new Script(...)` **仅解析不执行**（custom-validation.mjs:11），再起 `127.0.0.1:0` 临时 http 服务只允许 4 个文件，用 **headless Edge** 跑初始渲染与全部 checks；要求全部 ready，否则抛「自定义作品试运行失败」。返回 `{status:'passed',checks,initial,snapshots,note:'...教学事实待独立核对'}`。

---

## 4. 状态保存与恢复

- 路径 `dataDir/artifacts/interactive/<sessionId>/<artifactId>.json`，两者均须 UUID；写入为 temp + rename 原子替换（artifacts.mjs:6-11,26-31）。
- `stateSchema` 仅 4 种类型：`number{min,max}`、`boolean`、`enum{values}`（≤20，每个 ≤80 字符）、`array{min,max,maxItems}`（≤64 个有界数字）。**没有** string/object/null/嵌套。
- 恢复时 `read()` 重跑 `validateDocument`；`validateState` 失败回退初始状态并打 `stateWarning` 显示在卡片上（artifacts.mjs:36-40；interactive-ui.js:37）。
- **【轻微不一致】** `custom-sandbox.js:10` 又做了一次**静默**回落到 initialState，若状态从其它路径注入，用户看不到提示。
- **不可持久化**：闭包/全局变量、Worker/定时器、nonce、算法播放速度与播放中状态、任何未在 schema 声明的键（多余键直接判非法）。

---

## 5. 生成入口流程与反馈

顺序（generation.mjs:39-66）：角色门控 → 消息绑定（必须找到含本次 toolCallId 的 assistant 消息）→ 父作品归属校验 → `JSON.parse` → mode 白名单 → **仅 custom** 走 `protocol` → `runtime` → `review` 三段 → 发布。

- 尝试次数：键为 `sessionId + ':' + 最近 user 消息 entryId`，`count > 3` 抛「本轮自定义生成已达三次」；Map 超 200 条淘汰最旧。计数器**在校验之前自增**，故 JSON 解析失败也消耗一次机会。
- 失败反馈（仅 custom）：`{status:'error', stage, message(≤3000), next:'fix_and_revalidate'|'explain_failure', attempt, remaining}`。
- **【偏差】** components/algorithm/math **没有**这层包装，报错是普通 Error 文本（校验只在 `store.create` 内执行）。
- 审核：默认关闭；开启后把 `{document,validation}` 发给所选模型，system prompt 声明输入不可信、不调工具、只返回 `{verdict,summary,issues}`；超时 90s；不传截图；通过后写 `quality={runtime,review,facts:'unverified'}`。

---

## 6. `get_interactive_reference` 返回什么

只接受 7 个枚举 topic，**不能读任意文件**：

| topic | 返回 |
| --- | --- |
| `components` | `COMPONENTS.md` 全文 |
| `sdk` | `SDK.md` 全文 |
| `catalog` | `{sdkVersion:1, props: {节点类型:[允许字段名]}, next:'read_sdk_and_generate'}` |
| `repair` | 一段固定纠错指导 |
| `gradient`/`queue`/`policy` | 3 份完整可运行自定义作品文档（含 script） |

**【偏差】** `catalog` 只导出 prop 名，**不含**颜色白名单、数值区间、必填/可选、字段长度上限、树节点与深度上限——这些只在 `SDK.md` 文字或校验代码里。

---

## 7. 明确缺失的能力【实现：确实没有】

| 能力 | 结论 | 依据 |
| --- | --- | --- |
| 动画 tick / rAF（custom） | 没有。Worker 把 `setTimeout/setInterval` 置 undefined，无 rAF；frame 无 tick 消息类型 | custom-frame-source.mjs:10,66-67,74-77 |
| 宿主侧动画 | **存在但模型不可用**：算法播放器用 `setTimeout`，三档 1400/700/180ms | algorithm-player.js:13,24-37 |
| Canvas / WebGL | 没有 | custom-contract.mjs:25-29 |
| 任意 DOM / innerHTML / CSS | 没有 | custom-contract.mjs:35；custom-frame-source.mjs:24,28,41-43 |
| 通用手势 | 只有 point 的 down/up（无 move）+ 方向键；无 pinch/swipe/hover/wheel/长按/多指 | custom-frame-source.mjs:44-51 |
| 测量反馈 | 没有。高度只从 frame 发给 parent，模型代码拿不到任何尺寸 | custom-frame-source.mjs:66 |
| 网络 | 没有。置空 4 类 API + CSP `connect-src 'none'`/`img-src 'none'` | custom-frame-source.mjs:10；custom-frame.html:2 |
| 任意页面状态持久化 | 没有。状态键必须与 schema **完全相等** | custom-contract.mjs:14 |
| 文本输入 | 没有，只有 range/number/select | custom-contract.mjs:27 |
| 多组件注册 / 异步 render | 没有。`register` 只能一次，render/reduce 必须同步 | custom-frame-source.mjs:14-15 |
| 系统级内存配额 | 没有（README 自我声明） | 无相关代码 |

补充精确事实：

- **动态 `import()` 未被 bootstrap 显式屏蔽**。经典 Worker 里静态 `import` 是语法错误；外部 URL 的动态 import 被 CSP `script-src 'nonce-...' blob:`（无 `'self'`/http）挡住；但模型可以自己造 blob 再 `import()` 它。所以「无导入」严格说是「经典 Worker + CSP」共同保证，不是 bootstrap 单独保证。
- 模型可以自己 `postMessage` 伪造回复，但 frame 只接受 `id === pending.id` 的回复，且回复仍要过状态与树校验，不构成越权。
- 承载隔离主力的是 **UI 树白名单**（宿主只创建白名单标签、文字走 `textContent`、无任何 URL 属性），Worker 是 CPU 隔离的第二层。

---

## 8. 角色开关检查点与关闭后果

检查点（全部实现）：工具注册门控（generation.mjs:29）、会话工具白名单（bridge.mjs:191）、Skill 注入（generation.mjs:21）、tool_call 钩子 block（generation.mjs:25-27）、两个工具 execute 开头复查（:31,40）、发布前复查（:60）、角色数据层默认 false 与布尔强制（roles.mjs:23,44,46,67）、前端复选框（settings.html:43）。

关闭后：模型看不到工具也拿不到 Skill，调用被 block/throw；**历史卡片仍可打开与操作**（`get_interactive_artifact` / `save_interactive_artifact_state` 只校验分支绑定，不查角色开关）；已生成作品的 quality、父链、进度状态都保留。

---

## 9. 文档与代码不一致清单

1. **【偏差】「Worker 无导入」表述过绝对**（README:69、SDK.md:3）——见 §7 补充事实。
2. **【偏差】`catalog` 的「实际字段目录」名不副实**——只有 prop 名（generation.mjs:32）。
3. **【偏差】超时只文档化了一半**——只写了 1500ms，另有 7000ms 启动、2500ms 操作、5000 条静默上限。
4. **【偏差】两套状态键正则**——components `/^[a-z][a-z0-9_-]{0,31}$/`（允许短横线、全小写）vs custom `/^[a-z][a-zA-Z0-9_]{0,31}$/`（允许大写、禁短横线）；两份文档都只说「字母数字下划线」。
5. **【偏差】字节 vs 字符计数**——`protocol.mjs:34` 用 UTF-8 字节，`generation.mjs:38` 用 `maxLength:65536` 字符；中文密集文档可能一个门槛通过、另一个失败。
6. **【偏差】`custom-frame.js` 是生成件**——由 `build-custom-sdk.cjs:2` 拼接 `custom-contract.mjs` + `custom-frame-source.mjs`；本次逐行归一化比对确认当前三者一致，但**没有测试校验同步**；`create-interactive-preview.cjs:15` 用精确字符串替换 script 标签，改 `custom-frame.html` 会让离线预览静默退化。
7. **【偏差】README 内部计数漂移**——README:34 说离线预览 8 张卡片，README:75 说 11 张。
8. **【轻微】恢复警告路径不对称**——`artifacts.read` 会给 `stateWarning`，但 `custom-sandbox.js:10` 又静默回落。
9. **【轻微】`custom-sandbox.js:19` 处理 `reset` 时不 resolve 未决的 `runAction` promise**，只能靠 2500ms 超时。
10. **【文档正确但易误读】`custom-validation.mjs:15` 的 harness CSP 不是作品运行时 CSP**；作品运行时用 `custom-frame.html:2` 的 meta CSP。

**核对通过（非偏差）**：SDK.md 的 64KiB/48000、500 节点/12 层/100KB/9 色；COMPONENTS.md 的 0–12 输入；README 的 8 状态/24 组件/32KiB、「每次操作新建 Worker、1500ms 强杀、sandbox 仅 allow-scripts、nonce+来源校验、无动画 tick/Canvas/WebGL」、「最多 3 次尝试、checks ≤6、3 份完整源码示例」——逐条与代码一致。
