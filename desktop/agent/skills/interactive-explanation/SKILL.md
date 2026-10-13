---
name: interactive-explanation
description: 在 Reed 对话中用原生组件组合可操作的教学讲解。
---

# 交互讲解

此 Skill 由角色的「允许生成交互讲解」开关自动加载。不需要另选角色，也不需要手动绑定。技能说明不授予工具权限。

当改变参数、预测下一步、比较选择能帮助理解时，调用 generate_learning_ui；简单事实、普通聊天用文字即可。用户明确要交互时优先尝试。每次先聚焦一个学习问题，组合「观察对象 → 操作 → 可解释反馈 → 重置」。不要为了用组件而堆组件。

工具参数 document 是下述完整文档的 JSON 字符串。不要输出代码围栏让用户自己运行，不生成 HTML、JavaScript、CSS 或表达式。Reed 负责排版、交互和状态保存。最多 24 个节点、8 个整数状态、32 KiB；建议 4–6 个节点和 1–2 个状态。失败时依据工具错误修正，最多再试两次；仍失败说明局限并用文字讲解，不能声称生成成功。

## 完整算法执行优先使用确定性轨迹

用户要「完整快排过程」「跟随代码」「每次比较交换」「递归调用」时，不用静态 ArrayTrack 假装排序。使用 algorithm 模式，Reed 按版本固定的代码计算全过程，模型只指定输入和讲解重点。快排版本为 `quicksort-lomuto-v1`：JavaScript Lomuto 分区，最右元素作枢轴、严格小于比较、先左后右递归。卡片显示实际对应代码、变量、数组和调用栈，允许更改输入和控制播放。

input 允许 0–12 个 -999 至 999 的整数。不要提交代码、执行轨迹、stateSchema、nodes 或 initialState；轨迹由宿主计算。模型传入的 question 只做问题引导，不控制执行。如果用户提供的代码不是这个版本（如 Hoare、三路分区、首元素枢轴），先说明现有演示的实现差别，不能声称逐行执行了用户原代码。任意代码执行不在此能力范围。

用户：用代码完整展示 [7,3,9,2,5] 的快排，每次比较、交换和递归都要看见。
组合：选择固定版本算法播放器；无需模型编造每一步数组。工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"algorithm","algorithm":"quicksort-lomuto-v1","title":"快排：跟随代码走完整个排序","question":"逐步观察 Lomuto 快排如何比较、交换、放好枢轴，并完成全部左右递归。","source":{"kind":"illustrative","label":"确定性代码执行轨迹 · Lomuto v1"},"input":[7,3,9,2,5]}
```
成功后说明末尾枢轴和严格小于约定，引导用户使用下一步或自动播放。执行轨迹可确定核对，模型补充的讲解仍需核验。

## 自由组合组件

文档结构：
{"schemaVersion":1,"mode":"components","title":"标题","question":"让用户观察或尝试的具体问题","source":{"kind":"illustrative","label":"模型生成教学示例 · 待核验"},"stateSchema":{"choice":{"min":0,"max":2}},"initialState":{"choice":0},"nodes":[...]}

节点结构 {"id":"唯一标识","type":"下表类型","props":{...}}。状态名和 ID 用小写字母开头，后接小写字母、数字、下划线或短横线，至多32字符。状态必须在 [-100,100]，max-min <=20，初始状态必须完整。文本为纯文字。只允许下表参数，不添加样式或自造字段。

组件参数（? 表示可省略）：
- StringTracks: text(1–40字符), pattern(1–20字符), offsetState(状态名), knownThrough?(已知前缀长度) 或 knownByState?({每档值:已知前缀长度}，覆盖全部档位)，两者不能同时用。
- ArrayTrack: values(2–20个数字，每项在-999和999之间), highlightState?(状态名，表示左侧数量), pivotIndex?(数组下标), label?(80字内)。
- Pointer: label(80字内), index(整数) 或 indexState(状态名)，二选一。
- HighlightRange: label(80字内), start(整数) 或 startState(状态名)，end(整数) 或 endState(状态名)。
- NodeGraph: nodes(2–10项，每项{id,label}，label至多60字), edges(至多16项，每项{from,to,label?}，引用节点ID，label至多50字), activeState?(以索引选择高亮节点的状态名), label?(80字内)。
- Plot: label(80字内), max(0.001–1000), values([{label,value}]) 或 variantState(状态名)+valuesByState({每档值:[{label,value}]}), 二选一。每档1–8项，label至多40字，value在0和max之间；动态表必须覆盖全部档位。
- DiscreteSlider: label(80字内), state(状态名), labels?(依档位顺序的文本数组，数量等于max-min+1)。
- DragHandle: label(80字内), state(状态名), choices([{value,label}])，从min到max逐档列全，label至多40字。
- ChoiceFeedback: state(状态名), cases([{value,reason,correct?}])，从min到max逐档列全，reason至多500字，correct是布尔值。探索参数无需判对错。
- StageReveal: state(状态名), equals(某一档值), title(100字内), body(500字内)。
- Reset: label?(40字内)。

状态绑定靠同名引用完成：滑块改变 choice，图的 variantState=choice、反馈的 state=choice 就同步变化。多个状态目前彼此独立，不能计算表达式或联合状态条件；不支持的关系不要伪造。可将少量联合情况编码成一个离散状态。数值表必须先算清楚，再逐档列出。

教学核验：列出所用输入、初始状态、算法约定；亲自推演每档结果、边界和正确答案。KMP 的 next 定义、快排分区方式等要明确，不混用；近似值标明近似。固定数组不会因拖动自动交换，不声称演示完整排序。不得把滑块操作当作学生已掌握。工具成功只表示可渲染，不能据此声称教学事实可靠。卡片外用一两句话解释它演示什么、哪些是简化。版本调整使用工具返回的 artifactId 作为 parentArtifactId，新建作品，不覆盖历史。

## 成功 few-shot

以下示例演示完整组件文档，来自已通过原生交互检查的组合方式；需要将 JSON 序列化为工具的 document 参数。借鉴结构并重新核算新输入，不机械复用答案。新作品来源标记为「模型生成教学示例 · 待核验」。

### 数值探索：Bellman
用户：折扣率为什么影响更新目标？
组合：Plot + DiscreteSlider + ChoiceFeedback + Reset。只展示三个档位的一次备份，不声称学习收敛。
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"components","title":"折扣因子如何改变单步目标？","question":"固定奖励 r=1、下一状态价值 V=4，试着改变 γ。此处仅比较 γ=0、0.5、1。","source":{"kind":"illustrative","label":"模型生成教学示例 · 待核验"},"stateSchema":{"gamma":{"min":0,"max":2}},"initialState":{"gamma":1},"nodes":[{"id":"target","type":"Plot","props":{"label":"目标 r+γV","max":5,"variantState":"gamma","valuesByState":{"0":[{"label":"1+0×4","value":1}],"1":[{"label":"1+0.5×4","value":3}],"2":[{"label":"1+1×4","value":5}]}}},{"id":"control","type":"DiscreteSlider","props":{"state":"gamma","label":"折扣因子 γ","labels":["0","0.5","1"]}},{"id":"feedback","type":"ChoiceFeedback","props":{"state":"gamma","cases":[{"value":0,"reason":"γ=0，只考虑当前奖励，目标为1。"},{"value":1,"reason":"γ=0.5，下一状态贡献2，目标为3。"},{"value":2,"reason":"γ=1，目标为5；这里只展示一次更新，不说明无折扣无限时域问题一定收敛。"}]}},{"id":"reset","type":"Reset","props":{"label":"恢复初始值"}}]}
```

### KMP 对齐
用户：KMP 失配以后为什么能跳过一个起点？
组合：StringTracks + HighlightRange + DiscreteSlider + ChoiceFeedback + StageReveal + Reset；已知前缀随对齐变化，不把新对齐下未比较的字符标成已匹配。
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"components","title":"KMP：失配后为什么能跳过起点？","question":"文本 ABABABC、模式 ABABC，原位前四字符相同，第五字符失配。尝试移动模式串。","source":{"kind":"illustrative","label":"模型生成教学示例 · 待核验"},"stateSchema":{"offset":{"min":0,"max":2}},"initialState":{"offset":0},"nodes":[{"id":"tracks","type":"StringTracks","props":{"text":"ABABABC","pattern":"ABABC","offsetState":"offset","knownByState":{"0":4,"1":0,"2":2}}},{"id":"range","type":"HighlightRange","props":{"label":"原始对齐时已匹配的文本区间","start":0,"end":3}},{"id":"slider","type":"DiscreteSlider","props":{"label":"模式串移动格数","state":"offset","labels":["原位","右移1格","右移2格"]}},{"id":"feedback","type":"ChoiceFeedback","props":{"state":"offset","cases":[{"value":0,"reason":"原位第五字符失配：文本 A、模式 C。"},{"value":1,"reason":"模式首字符 A 对上已知 B，可以排除。"},{"value":2,"reason":"AB 前缀可以复用，继续比较后面的字符。","correct":true}]}},{"id":"reveal","type":"StageReveal","props":{"state":"offset","equals":2,"title":"利用已知信息","body":"已匹配的 ABAB 的最长真前后缀是 AB，长度为2，因此下一个可能的起点右移2格。"}},{"id":"reset","type":"Reset","props":{"label":"重新尝试"}}]}
```
成功后简短说明卡片操作及简化范围，不宣称用户已掌握。

### 快排分区
用户：快排中哪些元素应当放到枢轴左侧？
组合：ArrayTrack + Pointer + DragHandle + ChoiceFeedback + StageReveal + Reset。拖动的是划分数量，数组固定；不假装每一次交换已被执行。
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"components","title":"快排：一次分区的分界点","question":"原数组 [7,3,9,2,5]，枢轴5。观察候选排列 [3,2,7,9,5]，拖动分界线。","source":{"kind":"illustrative","label":"模型生成教学示例 · 待核验"},"stateSchema":{"cut":{"min":0,"max":4}},"initialState":{"cut":0},"nodes":[{"id":"array","type":"ArrayTrack","props":{"values":[3,2,7,9,5],"highlightState":"cut","pivotIndex":4,"label":"一种候选排列；高亮表示划入小于枢轴的左侧元素"}},{"id":"pivot","type":"Pointer","props":{"label":"枢轴位置","index":4}},{"id":"drag","type":"DragHandle","props":{"label":"拖动分界线","state":"cut","choices":[{"value":0,"label":"左侧0个"},{"value":1,"label":"左侧1个"},{"value":2,"label":"左侧2个"},{"value":3,"label":"左侧3个"},{"value":4,"label":"左侧4个"}]}},{"id":"feedback","type":"ChoiceFeedback","props":{"state":"cut","cases":[{"value":0,"reason":"3和2都小于5，左侧不能是空的。"},{"value":1,"reason":"还漏了一个小于5的元素。"},{"value":2,"reason":"正确：3和2小于5；7和9大于5。","correct":true},{"value":3,"reason":"左侧多放了一个大于5的元素。"},{"value":4,"reason":"左侧多放了两个大于5的元素。"}]}},{"id":"reveal","type":"StageReveal","props":{"state":"cut","equals":2,"title":"分区性质","body":"一种合法分区是 [3,2,5,7,9]；这里只验证分界性质，不演示交换顺序。"}},{"id":"reset","type":"Reset","props":{"label":"重置分界线"}}]}
```
成功后简短说明卡片操作及简化范围，不宣称用户已掌握。

### Attention 参数探索
用户：调高温度后，注意力权重会如何变化？
组合：Plot + DiscreteSlider + ChoiceFeedback + StageReveal + Reset。温度是探索参数，不设对错；权重先算再列成表，标明近似值。
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"components","title":"Attention：温度如何改变权重？","question":"固定注意力分数 [1,2,0]，调节温度观察 softmax(score/T)。","source":{"kind":"illustrative","label":"模型生成教学示例 · 待核验"},"stateSchema":{"temperature":{"min":1,"max":3}},"initialState":{"temperature":1},"nodes":[{"id":"plot","type":"Plot","props":{"label":"softmax(score/T)，按三位小数显示","max":1,"variantState":"temperature","valuesByState":{"1":[{"label":"词 A","value":0.245},{"label":"词 B","value":0.665},{"label":"词 C","value":0.09}],"2":[{"label":"词 A","value":0.307},{"label":"词 B","value":0.506},{"label":"词 C","value":0.186}],"3":[{"label":"词 A","value":0.322},{"label":"词 B","value":0.449},{"label":"词 C","value":0.23}]}}},{"id":"slider","type":"DiscreteSlider","props":{"label":"温度 T","state":"temperature","labels":["T=1","T=2","T=3"]}},{"id":"feedback","type":"ChoiceFeedback","props":{"state":"temperature","cases":[{"value":1,"reason":"词B权重约为0.665，较高分数占较大权重。"},{"value":2,"reason":"词B降到约0.506，分布更平。"},{"value":3,"reason":"词B约0.449，权重更接近均匀；分数排序仍不变。"}]}},{"id":"reveal","type":"StageReveal","props":{"state":"temperature","equals":3,"title":"推理边界","body":"这里只改变 softmax 温度，不改变查询、键、值向量；数值为三位小数近似，和可能不恰为1。"}},{"id":"reset","type":"Reset","props":{"label":"重置温度"}}]}
```
成功后简短说明卡片操作及简化范围，不宣称用户已掌握。

## 堆排序与数学：先选择内置计算模型

当前另有 `heapsort-max-v1`：大顶堆、从最后一个非叶节点自底向上建堆、迭代 siftDown、反复交换堆顶与末尾。它复用算法播放器并提供数组/有效堆二叉树双视图；排序尾部退出树。不要把它冒充小顶堆或其他源码版本。input 限制与快排相同。

数学使用 `mode: math`，不是 components 条形图。文档只含 schemaVersion、mode、math、title、question、source、initialState；不接收表达式、代码或模型生成采样点。`quadratic-v1` 表示 y=a(x−h)²+k，initialState 必须恰有 a∈[-3,3]、h,k∈[-4,4]、x∈[-5,5]。Reed 计算曲线、顶点、函数值与导数斜率，允许拖动探查位置。a=0 是常数函数，不称其有唯一顶点。

`linear-transform-2d-v1` 的 initialState 必须恰有 a,b,c,d,vx,vy∈[-3,3]，t∈[0,1]；矩阵按行 A=[[a,b],[c,d]]，v=(vx,vy)，当前显示 B(t)=(1−t)I+tA。显示目标与当前变换、基向量、单位方形的像、行列式与面积缩放。det A 的符号表示目标方向，|det A| 表示目标面积倍率；det B(t) 是当前插值矩阵，两者不能混淆。插值可能经过奇异矩阵，即使目标可逆。当前不支持任意函数表达式、三维或任意维矩阵；遇到不支持的题目用文字说明，不能伪造图形能力。

### 完整堆排序 few-shot
用户：用二叉树完整展示 [4,10,3,5,1] 的堆排序，比较和交换要与代码同步。
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"algorithm","algorithm":"heapsort-max-v1","title":"堆排序：数组与二叉树同步执行","question":"观察自底向上建大顶堆、下沉及最大值退出有效堆的全过程。","source":{"kind":"illustrative","label":"确定性代码执行轨迹 · 大顶堆"},"input":[4,10,3,5,1]}
```

### 函数图 few-shot
用户：二次函数的 a、h、k 分别怎样影响曲线？能看切线吗？
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"math","math":"quadratic-v1","title":"二次函数：参数怎样改变曲线？","question":"调节参数并拖动探查位置，观察顶点、函数值与切线斜率。","source":{"kind":"illustrative","label":"确定性函数计算"},"initialState":{"a":1,"h":0,"k":0,"x":1}}
```

### 线性代数 few-shot
用户：矩阵 [[1,1],[0,1]] 为什么叫剪切？面积为什么不变？
工具 generate_learning_ui 的 document 内容：
```json
{"schemaVersion":1,"mode":"math","math":"linear-transform-2d-v1","title":"二维线性变换：剪切与面积","question":"改变矩阵和变换进度，观察网格、基向量与单位正方形的像。","source":{"kind":"illustrative","label":"确定性矩阵计算"},"initialState":{"a":1,"b":1,"c":0,"d":1,"vx":1,"vy":1,"t":1}}
```
成功后指出默认剪切矩阵 det A=1，保持有向面积；更换参数后据实际值解释。图中超出固定视窗的部分会裁切，不能据可见面积估计行列式。
