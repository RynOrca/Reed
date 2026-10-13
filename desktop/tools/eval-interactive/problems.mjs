// Reed 交互讲解评估题库 v1
//
// 用途：分层抽样衡量「模型能否为学生问题生成可用的交互讲解」，并区分失败原因。
// 设计约束：
//   - prompt 必须是学生的自然问法，不能出现组件名、模式名或任何实现提示；
//     否则测的是「模型能否听懂指令」，不是「模型能否自己选对路径」。
//   - expectedMode 是「预期模型会选的模式」，用于对照，不作为评分门槛；
//     模型选别的模式但把题讲清楚了，同样算通过。
//   - withinEngine 记录该题的交互需求是否落在 Reed 现有 11 个组件 + 3 个固定引擎的能力内。
//     这是覆盖率的分母，必须靠人判断，不能由模型自评。
//   - 每道题都要有可独立判定的 correctness 依据，否则「做得好不好」无法回答。

/** 学科键 */
export const SUBJECTS = {
  dsa: '数据结构与算法',
  linalg: '线性代数',
  calculus: '高等数学',
  network: '计算机网络',
  co: '计算机组成',
  os: '操作系统',
};

/**
 * 需求类型 —— 决定失败原因归因方式
 *   plot    画图/可视化关系
 *   step    分步演示（执行轨迹类）
 *   param   参数探索（调参看变化）
 *   compare 对比判断
 *   none    正确答案就是不该生成交互界面（纯文字/静态图更合适）
 */
export const KINDS = ['plot', 'step', 'param', 'compare', 'none'];

/**
 * 覆盖判定 —— 该题是否落在现有能力内
 *   engine  现有固定引擎直接支持（algorithm 的 3 个版本、math 的 2 个模型）
 *   components  11 个原生组件能表达
 *   custom-only 只有模型自己写组件才可能做出来
 *   wrong  这题本身就不该用交互
 */
export const COVERAGE = ['engine', 'components', 'custom-only', 'wrong'];

export const PROBLEMS = [
  // ─────────────── 数据结构与算法 ───────────────
  {
    id: 'dsa-01',
    subject: 'dsa',
    kind: 'param',
    prompt: '我搞不懂冒泡排序为什么每一轮之后末尾就确定了。能不能让我自己调数组，看着它一轮一轮冒泡？',
    expectedMode: 'algorithm',
    withinEngine: 'custom-only',
    why: 'algorithm 只注册了洛穆托快排、大顶堆、KMP 三个版本，没有冒泡。要支持就得新增固定引擎或让模型写 custom。',
    interaction: '数组轨道 + 每轮已确定尾部高亮 + 手动步进',
    correctness: '每轮冒泡后最大值必须落在未排序段末尾；比较次数应为 n(n-1)/2 的逐步前缀。可用独立冒泡实现逐轮比对。',
  },
  {
    id: 'dsa-02',
    subject: 'dsa',
    kind: 'step',
    prompt: '二分查找的左右边界我总是写错，能不能一步一步给我看 lo 和 hi 怎么变，最后停在哪？',
    expectedMode: 'algorithm',
    withinEngine: 'custom-only',
    why: '二分查找不在固定引擎里。它天然适合执行轨迹播放器，属于「引擎能表达但没注册」的缺口。',
    interaction: '数组轨道 + lo/mid/hi 指针 + 步进',
    correctness: '结束条件 lo>hi；每步 mid=floor((lo+hi)/2)；查找失败时返回值必须是 -1。可用独立二分实现逐段比对。',
  },
  {
    id: 'dsa-03',
    subject: 'dsa',
    kind: 'step',
    prompt: '二叉树层序遍历到底是怎么用队列做的？我想看到节点一个个进队出队的顺序。',
    expectedMode: 'components',
    withinEngine: 'custom-only',
    why: 'components 的 NodeGraph 是静态关系图，没有队列视图；需要一个「队列 + 树遍历」组合视图。',
    interaction: '树 + 同步显示的队列 + 当前出队节点高亮',
    correctness: '层序序列必须等于按深度分组的从左到右序列。可用独立 BFS 产生期望序列比对。',
  },
  {
    id: 'dsa-04',
    subject: 'dsa',
    kind: 'step',
    prompt: 'Dijkstra 算法我只会背步骤，能不能给个带权图，让我看每次选中的顶点和距离表怎么更新？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要加权图 + 距离表 + 已确定集合三块联动，现有 NodeGraph 和 ArrayTrack 都表达不了。',
    interaction: '加权图 + 距离表 + 当前选中顶点 + 松弛过程',
    correctness: '最终距离必须等于独立 Dijkstra 的结果；每次选中的必须是当前未确定集合中距离最小的顶点（这是算法定义，不能错）。',
  },
  {
    id: 'dsa-05',
    subject: 'dsa',
    kind: 'step',
    prompt: '哈希表线性探测法插入的时候，冲突了往后找空位，我一直想象不出来具体怎么找。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要槽位数组 + 探测路径 + 装载因子联动。',
    interaction: '槽位数组 + 探测步数高亮 + 插入/查找演示',
    correctness: '插入位置必须等于从 h(k) 起第一个空槽；查找探测序列必须与插入时一致。可用独立线性探测实现比对。',
  },
  {
    id: 'dsa-06',
    subject: 'dsa',
    kind: 'param',
    prompt: '红黑树插入之后的旋转和重新染色太抽象了，能不能让我插几个数，看着树自己调整？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '红黑树需要颜色属性 + 旋转动画 + 不变量检查，是典型的库外需求。同时也是上界测试（可能过难）。',
    interaction: '着色二叉树 + 插入 + 旋转/变色 + 违反的不变量提示',
    correctness: '每次插入后必须满足五条红黑性质：根为黑、红节点子节点为黑、任一节点到叶子的黑高相同。可用独立实现或性质检查器判定。',
  },

  // ─────────────── 线性代数 ───────────────
  {
    id: 'la-01',
    subject: 'linalg',
    kind: 'plot',
    prompt: '矩阵乘法我一直记不住哪个行乘哪个列，能不能让我点一个元素就看到它是哪一行和哪一列算出来的？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '状态 schema 只支持有限数/布尔/枚举/有界数字数组（≤64 项），且没有矩阵视图组件。',
    interaction: 'A、B、C 三个矩阵 + 选中 C[i][j] 时高亮 A 的第 i 行与 B 的第 j 列',
    correctness: 'C[i][j] 必须等于 A 第 i 行与 B 第 j 列的点积。可用独立矩阵乘法逐元素比对。',
  },
  {
    id: 'la-02',
    subject: 'linalg',
    kind: 'plot',
    prompt: '特征值和特征向量到底"特征"在哪？我想看一个矩阵作用在向量上，方向不变只被拉伸是什么样。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: 'math 的 linear-transform-2d-v1 只做 B(t)=(1-t)I+tA 插值，不含特征分解。',
    interaction: '变换前后向量对比 + 可拖动输入向量 + 当方向对齐时给出提示',
    correctness: '特征向量方向在变换前后共线；拉伸倍数等于对应特征值。可用 2×2 特征多项式独立求解比对。',
  },
  {
    id: 'la-03',
    subject: 'linalg',
    kind: 'param',
    prompt: '行列式等于 0 就是不可逆，这个几何上是什么意思？我想调矩阵元素看面积怎么塌掉的。',
    expectedMode: 'math',
    withinEngine: 'engine',
    why: 'linear-transform-2d-v1 已经展示 det A 与单位面积，且明确区分奇异插值。这题应当命中现有引擎。',
    interaction: '基向量 + 单位正方形变形后的面积 + det 数值',
    correctness: '面积缩放倍数必须等于 |det A|；det=0 时面积必须为 0 且变换退化。可用行列式公式独立核对。',
  },
  {
    id: 'la-04',
    subject: 'linalg',
    kind: 'step',
    prompt: '高斯消元化成阶梯形，我总在中途算错。能不能一步步显示当前矩阵和正在用的主元？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要矩阵数值视图 + 行变换步骤 + 主元高亮，现有组件都不具备。',
    interaction: '当前矩阵 + 主元位置 + 本步行变换说明 + 步进',
    correctness: '每步必须只做行交换/行倍乘/行相加三类初等变换；最终阶梯形回代结果必须等于独立求解的方程解。',
  },
  {
    id: 'la-05',
    subject: 'linalg',
    kind: 'plot',
    prompt: '同一个向量在不同基底下坐标不一样，这个我没概念，能不能让我换基底看坐标变化？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要同一向量在两套基下的分解显示，属于库外可视化。',
    interaction: '同一向量 + 两组基向量 + 两组坐标数值',
    correctness: '坐标必须满足 v = Σ cᵢbᵢ；换基后数值应等于 B⁻¹v。可用独立数值计算比对。',
  },
  {
    id: 'la-06',
    subject: 'linalg',
    kind: 'plot',
    prompt: '奇异值分解说能把任意矩阵拆成旋转、拉伸、旋转，能画出来让我看这三步吗？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要 SVD 数值计算 + 三段变换演示。这是上界测试，对模型能力要求高。',
    interaction: '单位圆经 Vᵀ、Σ、U 三次变换的连续过程 + 奇异值标注',
    correctness: '三次变换合成必须等于原矩阵 A；奇异值必须非负且降序。可用独立 SVD 实现比对。',
  },

  // ─────────────── 高等数学 ───────────────
  {
    id: 'ma-01',
    subject: 'calculus',
    kind: 'plot',
    prompt: '我想看看不同的函数长什么样，能不能输入一个函数就给我画出图像，还能缩放看局部？',
    expectedMode: 'math',
    withinEngine: 'custom-only',
    why: 'math 只有 quadratic-v1（y=a(x-h)²+k）。「任意函数绘图」是需要新增的通用能力，也是六个学科里 ROI 最高的组件。',
    interaction: '函数图像 + 参数/范围调节',
    correctness: '采样点必须落在真实函数值上（在给定容差内）。可用独立求值逐点核对。注意：不能执行模型给的任意表达式字符串。',
  },
  {
    id: 'ma-02',
    subject: 'calculus',
    kind: 'param',
    prompt: '导数是切线斜率，我想在某一点看切线怎么跟着点移动，切线方程怎么变。',
    expectedMode: 'math',
    withinEngine: 'engine',
    why: 'quadratic-v1 已包含顶点与探查点切线。若题目用的是二次函数，应当命中现有引擎。',
    interaction: '曲线 + 可拖动点 + 该点切线 + 导数数值',
    correctness: '切线斜率必须等于该点导数值；切线过该点。可用解析导数独立核对。',
  },
  {
    id: 'ma-03',
    subject: 'calculus',
    kind: 'param',
    prompt: '定积分是面积，但黎曼和取极限我没感觉。能不能让我调分割数，看小矩形逼近曲线下面积？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要矩形绘制 + 分割数状态 + 面积求和，现有 Plot 只能画条形图、不能叠加曲线。',
    interaction: '曲线 + n 个矩形 + 黎曼和数值 + 精确值对照',
    correctness: '黎曼和必须等于各矩形面积之和（可由 n 和取点规则独立算出）；n 增大时必须单调趋近精确积分值。',
  },
  {
    id: 'ma-04',
    subject: 'calculus',
    kind: 'param',
    prompt: '泰勒展开为什么能逼近原函数？我想看展开到不同阶数时曲线是怎么贴合上去的。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要多项式系数计算 + 多条曲线叠加绘制。',
    interaction: '原函数 + 1..n 阶泰勒多项式叠加 + 阶数调节 + 误差显示',
    correctness: 'n 阶泰勒多项式系数必须等于 f⁽ᵏ⁾(x₀)/k!。可用符号/数值微分独立核对系数，并验证展开点处两者函数值与各阶导数值相等。',
  },
  {
    id: 'ma-05',
    subject: 'calculus',
    kind: 'plot',
    prompt: '左右极限不相等就是跳跃间断，我分不清几种间断点，能不能画给我看？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要在同一点显示左右极限值并分类，涉及可去/跳跃/无穷/振荡四类。',
    interaction: '分段函数图像 + 断点处左右极限标注 + 类型判断',
    correctness: '间断类型判定必须与左右极限是否存在、是否相等、是否有限一致。可用独立极限计算核对。',
  },
  {
    id: 'ma-06',
    subject: 'calculus',
    kind: 'param',
    prompt: '多元函数的方向导数，为什么沿着梯度方向变化最快？我想看不同方向的变化率。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要二元函数数值场 + 方向选择 + 变化率计算，属于上界测试。',
    interaction: '等值线/曲面 + 可选择方向 + 该方向变化率 + 梯度方向对照',
    correctness: '方向导数必须等于 ∇f·u（u 为单位向量）；梯度方向必须给出最大变化率，且最大值等于 |∇f|。可数值独立核对。',
  },

  // ─────────────── 计算机网络 ───────────────
  {
    id: 'net-01',
    subject: 'network',
    kind: 'step',
    prompt: 'TCP 三次握手我总是记混谁先发谁后发，能不能让我一步步看报文和状态怎么变？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要「时序图 + 双方状态机」视图。现有组件没有时序/消息序列视图——这是网络、组成、操作系统三科共同缺的主力视图。',
    interaction: '客户端/服务端两条时间线 + 报文箭头 + 双方状态 + 步进',
    correctness: '报文顺序必须是 SYN → SYN+ACK → ACK；状态迁移必须是 CLOSED→SYN_SENT→ESTABLISHED（客户端）与 LISTEN→SYN_RCVD→ESTABLISHED（服务端）。',
  },
  {
    id: 'net-02',
    subject: 'network',
    kind: 'param',
    prompt: '滑动窗口和流量控制的关系我搞不清，能不能调窗口大小看发送方什么时候必须停下来等确认？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要时间轴 + 在途未确认字节数 + 窗口占用可视化。',
    interaction: '发送时间轴 + 已发未确认区间 + 窗口边界 + 累计确认',
    correctness: '任一时刻在途未确认字节数不得超过窗口大小；窗口耗尽必须停止发送。可用独立模拟核对边界。',
  },
  {
    id: 'net-03',
    subject: 'network',
    kind: 'param',
    prompt: 'TCP 拥塞控制的慢开始和拥塞避免，cwnd 到底怎么变？我想看它随轮次怎么涨怎么掉。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要折线图 + 事件标记（超时/三个重复 ACK）。现有 Plot 只能画条形图，没有折线。',
    interaction: 'cwnd 随 RTT 变化折线 + 阈值 ssthresh + 事件标注',
    correctness: '慢开始阶段每 RTT 翻倍；达到 ssthresh 后每 RTT 线性 +1；超时后 ssthresh 减半且 cwnd 重置为 1；三个重复 ACK 走快重传快恢复。',
  },
  {
    id: 'net-04',
    subject: 'network',
    kind: 'step',
    prompt: '停等协议和后退 N 帧、选择重传的区别，能不能让我看同一个丢包场景下三者各自怎么重传？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要同一场景下三种协议并排对照，属于对比型可视化。',
    interaction: '三组时间轴并排 + 同一丢包时刻 + 各自重传范围',
    correctness: '停等每次只发一帧；后退 N 帧重传从丢失帧起的整个窗口；选择重传只重传丢失帧。三者重传数量关系必须可独立推导。',
  },
  {
    id: 'net-05',
    subject: 'network',
    kind: 'step',
    prompt: '子网划分和 CIDR 我总算不明白，给个 IP 和掩码，能不能帮我算网络号、广播地址和可用主机数？',
    expectedMode: 'components',
    withinEngine: 'components',
    why: '这是一道可以完全用有限输入 + 数值展示表达的题，不需要任意绘图。是「components 够用」的样本。',
    interaction: '输入 IP 与掩码 → 二进制对齐显示 → 网络号/广播地址/可用范围/Host 数',
    correctness: '网络号 = IP AND 掩码；广播地址 = 网络号 OR (NOT 掩码)；可用主机数 = 2^(32-前缀) - 2。可用独立计算核对。注意前缀 ≥31 时可用主机数的常规公式退化。',
  },
  {
    id: 'net-06',
    subject: 'network',
    kind: 'none',
    prompt: 'OSI 七层模型和 TCP/IP 四层模型的对应关系是什么？各层分别有哪些协议？',
    expectedMode: 'text',
    withinEngine: 'wrong',
    why: '这是概念对照记忆题。正确回答是一张静态对照表 + 文字说明，做成可交互控件没有增益，反而增加认知负担。',
    interaction: '（无）应当直接用文字/表格回答，不生成交互作品',
    correctness: '层数与对应关系、各层代表协议必须正确。这是一个「应当克制」的负样本。',
  },

  // ─────────────── 计算机组成 ───────────────
  {
    id: 'co-01',
    subject: 'co',
    kind: 'step',
    prompt: '补码加减法我老是搞错溢出判断，能不能让我输两个数看二进制逐位运算和溢出标志？',
    expectedMode: 'components',
    withinEngine: 'components',
    why: '有限整数输入 + 逐位展示，components 的数组轨道类表达可以做，属于「components 够用」的样本。',
    interaction: '两个操作数的二进制位对齐 + 逐位进位 + 结果 + 溢出标志',
    correctness: '补码加法结果必须等于 (a+b) mod 2ⁿ 的补码解释；溢出判定为最高位进位与次高位进位异或。可用独立计算核对。',
  },
  {
    id: 'co-02',
    subject: 'co',
    kind: 'param',
    prompt: 'IEEE 754 浮点数的符号位、阶码、尾数怎么拼出来的？我想看一个数怎么变成 32 位。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要位域分段显示 + 规格化过程，涉及指数偏移与舍入。',
    interaction: '输入实数 → 规格化过程 → 三段位域拼接 → 十六进制结果',
    correctness: '必须符合 IEEE 754 单精度规则：偏移量 127、隐含前导 1、最近偶数舍入。可用独立实现逐位比对。',
  },
  {
    id: 'co-03',
    subject: 'co',
    kind: 'step',
    prompt: 'Cache 的组相联映射，主存地址怎么拆成标记、组号、块内地址？我想看一个地址会落到哪一组。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要地址位域拆分 + Cache 组/路布局 + 命中判断联动。',
    interaction: '地址位域拆分 + Cache 组布局 + 命中/替换演示',
    correctness: '组号 = 地址中间的 log2(组数) 位；标记为剩余高位。组号必须与独立按位运算结果一致。',
  },
  {
    id: 'co-04',
    subject: 'co',
    kind: 'step',
    prompt: '指令流水线的时空图我看不懂，能不能让我看每条指令每一拍在哪个阶段，还有数据冒险在哪？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要时空图（甘特图式）+ 冒险检测 + 停顿插入。同时也是「网络/组成/操作系统共缺的时序视图」样本。',
    interaction: '指令 × 时钟周期网格 + 各阶段占用 + 冒险标红 + 气泡',
    correctness: '理想流水线总拍数 = 指令数 + 流水级数 - 1；插入停顿后必须能消除对应数据冒险（RAW）。可用独立流水线模拟核对。',
  },
  {
    id: 'co-05',
    subject: 'co',
    kind: 'step',
    prompt: '指令周期里取指、间址、执行、中断这几个阶段，微操作序列我总是背不下来。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要状态机 + 微操作列表同步。与 net-01 同属时序/流程视图缺口。',
    interaction: '阶段状态机 + 当前阶段微操作序列 + 步进',
    correctness: '各阶段的微操作必须完整且顺序正确（如取指必须有 PC→MAR、M→MDR、MDR→IR、PC+1）。可用教材标准序列核对。',
  },
  {
    id: 'co-06',
    subject: 'co',
    kind: 'none',
    prompt: '原码、反码、补码的定义分别是什么？0 的表示有什么区别？',
    expectedMode: 'text',
    withinEngine: 'wrong',
    why: '定义与列举题。正确回答是文字加一张小对照表；交互控件不增加理解，反而把简单问题复杂化。',
    interaction: '（无）应当直接用文字/表格回答',
    correctness: '三种编码定义必须正确；补码 0 唯一而原码/反码有 ±0。这是第二个「应当克制」的负样本。',
  },

  // ─────────────── 操作系统 ───────────────
  {
    id: 'os-01',
    subject: 'os',
    kind: 'step',
    prompt: '先来先服务、短作业优先、时间片轮转这几种调度算法，能不能给同一组进程看各自的执行顺序和平均周转时间？',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要甘特图 + 多算法并排 + 周转时间计算。时序/甘特视图缺口。',
    interaction: '进程列表 + 多算法甘特图 + 各自平均周转/带权周转时间',
    correctness: 'FCFS 按到达顺序；SJF 每次选剩余运行时间最短者（注意是非抢占式）；RR 按时间片轮转。平均周转时间 = Σ(完成-到达)/n。可用独立模拟核对。',
  },
  {
    id: 'os-02',
    subject: 'os',
    kind: 'step',
    prompt: '页面置换算法 OPT、FIFO、LRU 的缺页次数差别在哪？我想用同一个访问串对比看。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要访存串 + 多算法并排的物理块状态演变。',
    interaction: '访问串 + 三算法并排的块内容演变 + 缺页计数',
    correctness: 'OPT 淘汰未来最久不用者；FIFO 淘汰最早进入者（注意 Belady 异常是允许的）；LRU 淘汰最久未使用者。缺页次数必须与独立模拟一致。',
  },
  {
    id: 'os-03',
    subject: 'os',
    kind: 'step',
    prompt: '分页存储里逻辑地址怎么变成物理地址？我想看页号页内偏移怎么拆、查页表、最后拼出物理地址。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要地址拆分 + 页表查找 + 地址拼接，可能还要支持两级页表。',
    interaction: '逻辑地址位域 + 页表查询 + 物理地址拼接 + 缺页提示',
    correctness: '页号 = 逻辑地址 div 页大小；页内偏移 = 逻辑地址 mod 页大小；物理地址 = 页框号 × 页大小 + 偏移。可用独立计算核对。',
  },
  {
    id: 'os-04',
    subject: 'os',
    kind: 'step',
    prompt: '银行家算法的安全性检查怎么走？我想看每一步 Work 和 Finish 怎么更新，为什么某个请求不能批。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要 Available/Max/Allocation/Need 多表联动 + 安全序列搜索过程。',
    interaction: '四张表 + Work/Finish 演变 + 安全序列 + 请求可否满足的判定',
    correctness: '安全性检查必须按 Need ≤ Work 找可完成进程；存在安全序列则安全。请求检查必须同时满足 Request ≤ Need 且 Request ≤ Available。可用独立实现核对。',
  },
  {
    id: 'os-05',
    subject: 'os',
    kind: 'step',
    prompt: 'PV 操作和信号量，生产者消费者为什么必须有两个信号量？我想看缓冲区满了或空了会怎样。',
    expectedMode: 'custom',
    withinEngine: 'custom-only',
    why: '需要缓冲区状态 + 两个信号量数值 + 进程阻塞/唤醒联动。',
    interaction: '缓冲区槽位 + empty/full/mutex 数值 + 进程状态 + 单步执行',
    correctness: 'empty+full 必须恒等于缓冲区容量；mutex ∈{0,1}；缓冲区满时生产者必须阻塞，空时消费者必须阻塞。可用独立信号量模拟核对。',
  },
  {
    id: 'os-06',
    subject: 'os',
    kind: 'none',
    prompt: '什么是死锁？产生死锁的四个必要条件是什么？',
    expectedMode: 'text',
    withinEngine: 'wrong',
    why: '定义与列举题。四个必要条件用文字列举最清楚；做成交互控件属于过度设计。第三个「应当克制」的负样本。',
    interaction: '（无）应当直接用文字回答',
    correctness: '必须列出互斥、占有并等待、不可抢占、循环等待四项，且不能与「死锁处理策略」混淆。',
  },
];

/** 按学科分组，便于统计 */
export function bySubject(problems = PROBLEMS) {
  return problems.reduce((map, problem) => {
    (map[problem.subject] ||= []).push(problem);
    return map;
  }, {});
}

/** 自检：题库结构完整性。任何一条缺失都会让覆盖率统计失真。 */
export function auditProblems(problems = PROBLEMS) {
  const issues = [];
  const seen = new Set();
  for (const problem of problems) {
    const at = `[${problem.id}]`;
    if (seen.has(problem.id)) issues.push(`${at} id 重复`);
    seen.add(problem.id);
    if (!Object.hasOwn(SUBJECTS, problem.subject)) issues.push(`${at} 学科未知：${problem.subject}`);
    if (!KINDS.includes(problem.kind)) issues.push(`${at} 需求类型未知：${problem.kind}`);
    if (!COVERAGE.includes(problem.withinEngine)) issues.push(`${at} 覆盖判定未知：${problem.withinEngine}`);
    for (const field of ['prompt', 'why', 'interaction', 'correctness']) {
      if (typeof problem[field] !== 'string' || !problem[field].trim()) issues.push(`${at} 缺字段 ${field}`);
    }
    // prompt 里不能泄露实现细节，否则测的不是「模型自己选对路径」
    const leaked = ['components', 'algorithm', 'math 模式', 'custom', 'sandbox', 'Worker', 'JSON', 'schema', 'SDK', 'Reed']
      .filter(token => problem.prompt.includes(token));
    if (leaked.length) issues.push(`${at} prompt 泄露实现词：${leaked.join(', ')}`);
  }
  for (const [subject, list] of Object.entries(bySubject(problems))) {
    if (list.length !== 6) issues.push(`学科 ${subject} 题数 ${list.length}，应为 6`);
  }
  const missing = Object.keys(SUBJECTS).filter(subject => !bySubject(problems)[subject]);
  if (missing.length) issues.push(`缺学科：${missing.join(', ')}`);
  return issues;
}

