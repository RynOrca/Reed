# Reed 交互讲解评估

用途：用**真实模型**跑一批**分层抽样**的学生问题，衡量两件事——

1. 模型能不能为学生问题生成可用的交互讲解？
2. 生成不出来的那些，究竟是**组件库不够**、**模型能力不够**，还是**这题本来就不该做交互**？

这是 [INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md](../../../INTELLIGENCE-UI-INTEGRATION-ASSESSMENT.md) 里第 0 步的落地工具。没有这份数据，任何「要不要继续投入 UI 能力」的决定都是猜的。

## 目录内容

| 文件 | 作用 |
| --- | --- |
| `problems.mjs` | 题库：六科 × 6 题 = 36 题，含覆盖判定与可独立核对的正误依据 |
| `run-eval.mjs` | 评估驱动：隔离启动 Reed agent 桥、逐题提问、采集结果、产出报告 |
| `eval.test.mjs` | 单元测试：题库自检、判定口径、报告格式、隔离桥启动 |
| `results/` | 运行产物（`eval-<时间>.md` 与 `.json`），已被 `.gitignore` 排除 |

## 题库设计

六科：数据结构与算法、线性代数、高等数学、计算机网络、计算机组成、操作系统。每科 6 题。

**每题都带一个「覆盖判定」，这是区分失败原因的关键**（必须靠人判断，不能让模型自评）：

| 判定 | 含义 |
| --- | --- |
| `engine` | 现有固定引擎（3 个 algorithm 版本、2 个 math 模型）直接支持 |
| `components` | 现有 11 个原生组件能表达 |
| `custom-only` | 只有模型自己写组件才可能做出来 |
| `wrong` | **这题本来就不该用交互**（纯文字/静态表更合适） |

**每题还带一个「需求类型」**：`plot` 画图 / `step` 分步演示 / `param` 参数探索 / `compare` 对比 / `none` 应当克制。

`none` 是**负样本**——用来发现「过度生成」。网络、组成、操作系统各有一道（OSI 分层、原码反码补码定义、死锁四个必要条件），正确回答是文字，做成交互控件属于过度设计。

每道题都有 `correctness` 字段，写明**如何独立判定它对不对**（例如冒泡每轮最大值必须落到未排序段末尾、方向导数必须等于 ∇f·u）。没有这一条，「做得好不好」就无法回答。

**prompt 红线：** 题目必须是学生的自然问法，不能出现组件名、模式名或任何实现提示。否则测的是「模型能不能听懂指令」，而不是「模型能不能自己选对路径」。`auditProblems()` 会自动拦截泄露。

## 怎么跑

### 1. 准备凭据（只走环境变量）

```powershell
$env:REED_EVAL_BASE_URL = "https://api.deepseek.com/v1"
$env:REED_EVAL_API_KEY  = "sk-..."     # 不会被写进任何结果文件
$env:REED_EVAL_MODEL    = "deepseek-chat"
```

可选：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `REED_EVAL_TEMPLATE` | `custom` | 对应 `providers.mjs` 的 preset id |
| `REED_EVAL_PROTOCOL` | `openai-completions` | 或 `anthropic-messages` |
| `REED_EVAL_THINKING` | 不设置 | 如 `low` / `medium`；留空则不发送 |
| `REED_EVAL_TIMEOUT` | `300000` | 单题超时（毫秒） |

### 2. 先跑少量题目确认链路

```powershell
node desktop/tools/eval-interactive/run-eval.mjs --only dsa-01,la-03,net-06
```

`--only` 非常重要：**先用 3 题确认接口、模型、角色开关都通，再跑全部 36 题**，避免浪费额度。

### 3. 跑全套

```powershell
node desktop/tools/eval-interactive/run-eval.mjs
```

约 36 次模型调用。报告与原始数据写入 `results/`，同时在终端打印报告。

### 4. 跑测试（不需要凭据）

```powershell
cd desktop/agent
node --test ../tools/eval-interactive/eval.test.mjs
```

## 安全边界

- **不碰真实用户数据**：所有状态写在系统临时目录，跑完删除。不读写 Reed 的真实数据目录。
- **不修改生产代码**：题库与驱动都在 `desktop/tools/` 下，Reed 运行时不会加载它们。
- **API Key 只经环境变量**：结果文件里只有接口地址、模型名和题目结果，没有凭据。
- **每题独立会话**：每题前 `new_session`，避免上一题的对话历史影响下一题。
- **角色开关真实生效**：驱动会显式打开内置角色 `agent` 的 `interactiveUiEnabled`；关闭时工具根本不注册，模型看不到这套能力——所以这一步必须成功，否则测的是别的东西。

## 判读结果

判定口径（`classify()`）：

| 结局 | 含义 |
| --- | --- |
| `validated` | 生成了 `custom` 作品，且通过 Reed 的真实沙箱试运行（初始渲染 + 全部 checks） |
| `static-only` | 生成了作品，但该模式**只有静态校验**，渲染正确性未经真实执行验证 |
| `no-artifact` | 预期需要交互，模型却只给了文字 |
| `over-generated` | 题目正确答案就是文字，模型却生成了交互作品 |
| `text-correct` | 负样本上正确保持了文字回答 |
| `error` | 桥层报错、超时或作品无法读取 |

### ⚠️ 已知盲区：`static-only` 占大多数时不要过度解读

Reed 目前**只有 `custom` 模式有真实试运行**。`components` / `algorithm` / `math` 三种模式只做静态协议校验——也就是说，报告里 `static-only` 的作品**只证明协议合法，不证明它渲染正确、更不证明教学事实正确**。

这是评估能力的真实边界，不是可以糊过去的地方。看到 `static-only` 很多时，正确结论是「需要补上这三个模式的运行时校验」，而不是「覆盖率很高」。

### 事实层仍需人工核对

本工具只衡量**能否生成并跑通**。教学事实是否正确，需要按题库 `correctness` 字段人工或独立算法核对。`quality.facts` 恒为 `unverified`，不要把它读成通过。

## 拿结果做什么

拿到覆盖率表后，按这个顺序决策：

1. **`custom-only` 的失败集中在协议/运行时报错** → 缺的是反馈质量，优先补 inspect 快照与字段路径（见效快、成本低）。
2. **失败集中在语义/教学错误**（能跑但算错） → 说明「让模型写代码」本身有风险，应转成「模型只填数据、Reed 负责渲染」，提高策展组件的表达上限。
3. **`over-generated` 偏多** → Skill 里要显式教「什么时候不该做交互」。
4. **某一科系统性失败** → 那科的缺的往往是**同一类视图**（例如网络/组成/操作系统的失败会集中在「时序/甘特图」缺口），据此排组件库优先级。

## 扩展题库

改 `problems.mjs` 的 `PROBLEMS` 数组即可。加完跑一次 `node --test`——`auditProblems()` 会检查：

- 六科各 6 题（改动题数时同步更新这个断言）
- id 不重复、学科/需求类型/覆盖判定取值合法
- 四个说明字段非空
- `prompt` 不泄露实现词（`components` / `algorithm` / `custom` / `JSON` / `SDK` 等）
- 负样本至少 3 道且覆盖判定为 `wrong`
