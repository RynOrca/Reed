const base = (title, question, stateSchema, initialState, nodes) => ({
  schemaVersion: 1, mode: 'components', title, question,
  source: { kind: 'illustrative', label: '固定教学样例' }, stateSchema, initialState, nodes,
});
const node = (id, type, props) => ({ id, type, props });

export function createFixedDocument(topic = 'kmp') {
  switch (topic) {
    case 'heapsort': return {schemaVersion:1,mode:'algorithm',algorithm:'heapsort-max-v1',title:'堆排序：数组与二叉树同步执行',question:'观察自底向上建堆、父子比较、下沉与取出最大值的完整过程；树中只保留有效堆。',source:{kind:'illustrative',label:'确定性代码执行轨迹 · 大顶堆'},input:[4,10,3,5,1]};
    case 'quadratic': return {schemaVersion:1,mode:'math',math:'quadratic-v1',title:'二次函数：参数怎样改变曲线？',question:'调节 a、h、k，拖动探查位置，观察顶点、函数值与切线斜率。',source:{kind:'illustrative',label:'确定性函数计算'},initialState:{a:1,h:0,k:0,x:1}};
    case 'linear-transform': return {schemaVersion:1,mode:'math',math:'linear-transform-2d-v1',title:'线性代数：矩阵怎样变换平面？',question:'编辑目标矩阵和向量，调节变换进度，观察基向量、网格与面积如何变化。',source:{kind:'illustrative',label:'确定性矩阵计算'},initialState:{a:1,b:1,c:0,d:1,vx:1,vy:1,t:1}};
    case 'quicksort-full': return {
      schemaVersion:1,mode:'algorithm',algorithm:'quicksort-lomuto-v1',title:'快排：跟随代码走完整个排序',
      question:'逐步观察比较、交换、枢轴归位和左右递归，直到数组有序；可以在下方更换输入。',
      source:{kind:'illustrative',label:'确定性代码执行轨迹'},input:[7,3,9,2,5],
    };
    case 'kmp': return base('KMP：失配后为什么能跳过起点？', '把模式串移动到你认为下一个可能匹配的位置。', { offset: { min: 0, max: 2 } }, { offset: 0 }, [
      node('tracks', 'StringTracks', { text: 'ABABABC', pattern: 'ABABC', offsetState: 'offset', knownByState: { 0: 4, 1: 0, 2: 2 } }),
      node('range', 'HighlightRange', { label: '原始对齐时已匹配的文本区间', start: 0, end: 3 }),
      node('slider', 'DiscreteSlider', { label: '模式串移动格数', state: 'offset', labels: ['原位', '右移 1 格', '右移 2 格'] }),
      node('feedback', 'ChoiceFeedback', { state: 'offset', cases: [
        { value: 0, reason: '原位在第 5 个字符失配：文本是 A，模式串是 C。' },
        { value: 1, reason: '右移一格时，模式串首字符 A 会对上已知的 B，因此可排除。' },
        { value: 2, reason: '右移两格时，已匹配的 AB 前缀可复用，从尚未比较的位置继续。', correct: true },
      ] }),
      node('reveal', 'StageReveal', { state: 'offset', equals: 2, title: '关键观察', body: '不是“跳过两次比较”，而是利用已知前后缀相同，排除不可能的起点。' }),
      node('reset', 'Reset', { label: '重新尝试' }),
    ]);
    case 'quicksort': return base('快排：一次分区的分界点', '原数组 [7,3,9,2,5]，枢轴是 5。观察候选排列，拖动分界线。', { cut: { min: 0, max: 4 } }, { cut: 0 }, [
      node('array', 'ArrayTrack', { values: [3, 2, 7, 9, 5], highlightState: 'cut', pivotIndex: 4, label: '一种候选排列；高亮表示划入“小于枢轴”的左侧元素' }),
      node('pivot', 'Pointer', { label: '枢轴位置', index: 4 }),
      node('drag', 'DragHandle', { label: '拖动分界线', state: 'cut', choices: [
        { value: 0, label: '左侧 0 个' }, { value: 1, label: '左侧 1 个' }, { value: 2, label: '左侧 2 个' }, { value: 3, label: '左侧 3 个' }, { value: 4, label: '左侧 4 个' },
      ] }),
      node('feedback', 'ChoiceFeedback', { state: 'cut', cases: [
        { value: 0, reason: '3 和 2 都小于 5，左侧不能是空的。' },
        { value: 1, reason: '还漏了一个小于 5 的元素。' },
        { value: 2, reason: '正确：3 和 2 在左侧，7 和 9 在右侧；具体交换顺序可不同。', correct: true },
        { value: 3, reason: '左侧多放了一个大于 5 的元素。' },
        { value: 4, reason: '左侧多放了两个大于 5 的元素。' },
      ] }),
      node('reveal', 'StageReveal', { state: 'cut', equals: 2, title: '分区结果', body: '一种合法分区是 [3, 2, 5, 7, 9]；这里只验证分界性质，不演示每次交换。' }),
      node('reset', 'Reset', { label: '重置分界线' }),
    ]);
    case 'attention': return base('Attention：温度如何改变权重？', '固定三个注意力分数 [1, 2, 0]，调节温度观察 softmax 权重。', { temperature: { min: 1, max: 3 } }, { temperature: 1 }, [
      node('plot', 'Plot', { label: 'softmax(score / 温度)，按三位小数显示', max: 1, variantState: 'temperature', valuesByState: {
        1: [{ label: '词 A', value: 0.245 }, { label: '词 B', value: 0.665 }, { label: '词 C', value: 0.09 }],
        2: [{ label: '词 A', value: 0.307 }, { label: '词 B', value: 0.506 }, { label: '词 C', value: 0.186 }],
        3: [{ label: '词 A', value: 0.322 }, { label: '词 B', value: 0.449 }, { label: '词 C', value: 0.23 }],
      } }),
      node('slider', 'DiscreteSlider', { label: '温度 T', state: 'temperature', labels: ['T = 1', 'T = 2', 'T = 3'] }),
      node('feedback', 'ChoiceFeedback', { state: 'temperature', cases: [
        { value: 1, reason: 'T=1：较高分数占较大权重，词 B 约为 0.665。' },
        { value: 2, reason: 'T=2：分布更平，词 B 降到约 0.506。' },
        { value: 3, reason: 'T=3：权重更接近均匀分布；分数排序仍不变。' },
      ] }),
      node('reveal', 'StageReveal', { state: 'temperature', equals: 3, title: '推理边界', body: '这里仅改变 softmax 温度，不改变查询、键、值向量；数字是固定教学例子。' }),
      node('reset', 'Reset', { label: '重置温度' }),
    ]);
    case 'bellman': {
      const valuesByState = {};
      for (let n = 0; n <= 10; n++) valuesByState[n] = [
        { label: '即时奖励 r', value: 1 }, { label: '折扣后未来价值', value: Number((0.4 * n).toFixed(1)) }, { label: '更新目标', value: Number((1 + 0.4 * n).toFixed(1)) },
      ];
      return base('Bellman：折扣率影响更新目标', '设 r=1，下一状态价值为 4；拖动 γ，观察 r + γ·4。', { gamma_tenths: { min: 0, max: 10 } }, { gamma_tenths: 5 }, [
        node('graph', 'NodeGraph', { label: '单步状态转移', nodes: [{ id: 'current', label: '状态 s' }, { id: 'next', label: '下一状态 s′' }], edges: [{ from: 'current', to: 'next', label: '奖励 r = 1' }] }),
        node('slider', 'DiscreteSlider', { label: '折扣率 γ', state: 'gamma_tenths', labels: Array.from({ length: 11 }, (_, i) => (i / 10).toFixed(1)) }),
        node('plot', 'Plot', { label: '更新目标 r + γ·V(s′)', max: 5, variantState: 'gamma_tenths', valuesByState }),
        node('feedback', 'ChoiceFeedback', { state: 'gamma_tenths', cases: Array.from({ length: 11 }, (_, i) => ({ value: i, reason: `γ=${(i / 10).toFixed(1)} 时，目标 = 1 + ${(i / 10).toFixed(1)}×4 = ${(1 + 0.4 * i).toFixed(1)}。` })) }),
        node('reveal', 'StageReveal', { state: 'gamma_tenths', equals: 5, title: '不要混淆', body: '这是单步 Bellman 备份的目标值；它不是已学到的 V(s)，更新步长还会影响实际参数变化。' }),
        node('reset', 'Reset', { label: '回到 γ=0.5' }),
      ]);
    }
    default: throw new Error('未知的固定教学样例');
  }
}

