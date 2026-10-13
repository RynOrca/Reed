// The displayed source and trace share this version. Never execute model-supplied code.
export const QUICKSORT_VERSION = 'quicksort-lomuto-v1';
export const QUICKSORT_CODE = [
  'function quicksort(a, low = 0, high = a.length - 1) {',
  '  if (low >= high) return;',
  '  const p = partition(a, low, high);',
  '  quicksort(a, low, p - 1);',
  '  quicksort(a, p + 1, high);',
  '}',
  'function partition(a, low, high) {',
  '  const pivot = a[high];',
  '  let i = low;',
  '  for (let j = low; j < high; j++) {',
  '    if (a[j] < pivot) {',
  '      [a[i], a[j]] = [a[j], a[i]];',
  '      i++;',
  '    }',
  '  }',
  '  [a[i], a[high]] = [a[high], a[i]];',
  '  return i;',
  '}',
];

export function validSortInput(input) {
  return Array.isArray(input) && input.length <= 12 && input.every(value => Number.isInteger(value) && value >= -999 && value <= 999);
}

export function createQuicksortTrace(input) {
  if (!validSortInput(input)) throw new Error('数组需包含 0–12 个 -999 至 999 的整数');
  const a = [...input], stack = [], steps = [], fixed = new Set();
  let comparisons = 0, swaps = 0;
  const emit = (line, action, explanation, marks = []) => {
    const frame = stack.at(-1);
    steps.push({ line, action, explanation, marks: [...marks], array: [...a], stack: stack.map(item => ({ ...item })),
      variables: frame ? { ...frame } : {}, fixed: [...fixed], comparisons, swaps });
  };
  function partition(low, high) {
    const frame = { kind: 'partition', low, high }; stack.push(frame);
    emit(7, '进入分区', `在 [${low}, ${high}] 内分区，选最右元素作为枢轴。`);
    frame.pivot = a[high]; frame.pivotIndex = high;
    emit(8, '选定枢轴', `pivot = a[${high}] = ${frame.pivot}；比较采用严格小于。`, [high]);
    frame.i = low;
    emit(9, '初始化边界', `i = ${low}。区间 [low, i) 初始为空，用于收集小于枢轴的元素。`);
    for (frame.j = low; frame.j < high; frame.j++) {
      emit(10, '检查循环', `j = ${frame.j} < high = ${high}，检查当前元素。`, [frame.j]);
      comparisons++;
      const less = a[frame.j] < frame.pivot;
      emit(11, '比较', `${a[frame.j]} < ${frame.pivot} 为${less ? '真' : '假'}。${less ? '将当前元素放入左侧小于区间。' : '留在尚不小于枢轴的一侧，继续扫描。'}`, [frame.j, high]);
      if (less) {
        const left = frame.i, right = frame.j;
        [a[left], a[right]] = [a[right], a[left]];
        if (left !== right) swaps++;
        emit(12, left === right ? '原位交换' : '交换', left === right ? `i 与 j 都为 ${left}，执行自交换，数组不变。` : `交换 a[${left}] 与 a[${right}]，把小元素移到左侧。`, [left, right]);
        frame.i++;
        emit(13, '推进边界', `i 增至 ${frame.i}；[${low}, ${frame.i}) 内元素都小于 ${frame.pivot}。`);
      }
    }
    emit(10, '结束扫描', `j = high = ${high}，循环结束；准备把枢轴放到索引 i = ${frame.i}。`);
    const p = frame.i;
    [a[p], a[high]] = [a[high], a[p]];
    if (p !== high) swaps++;
    frame.pivotIndex = p; fixed.add(p);
    emit(16, '枢轴归位', `交换 a[${p}] 与 a[${high}]；枢轴 ${frame.pivot} 的最终位置为 ${p}。左侧严格小于枢轴，右侧大于或等于枢轴。`, [p, high]);
    emit(17, '返回分界', `partition 返回 ${p}。之后的递归不会再移动此枢轴。`, [p]);
    stack.pop(); return p;
  }
  function quicksort(low, high) {
    const frame = { kind: 'quicksort', low, high }; stack.push(frame);
    emit(1, '进入递归', `调用 quicksort(a, ${low}, ${high})。`);
    emit(2, '检查递归边界', `${low} >= ${high} 为${low >= high ? '真，直接返回' : '假，需要分区'}。`);
    if (low >= high) {
      if (low === high) fixed.add(low);
      emit(2, '递归返回', low === high ? `区间只有索引 ${low} 一个元素，不需要排序。` : '这是空区间，不访问数组，直接返回。');
      stack.pop(); return;
    }
    emit(3, '调用分区', `暂停当前 quicksort，调用 partition(a, ${low}, ${high})。`);
    frame.p = partition(low, high);
    emit(3, '接收分界', `p = ${frame.p}，分成 [${low}, ${frame.p - 1}] 和 [${frame.p + 1}, ${high}] 两个子问题。`);
    emit(4, '递归左侧', `先排序左侧 [${low}, ${frame.p - 1}]；当前调用留在栈中等待。`);
    quicksort(low, frame.p - 1);
    emit(5, '递归右侧', `左侧已返回，接着排序右侧 [${frame.p + 1}, ${high}]。`);
    quicksort(frame.p + 1, high);
    emit(6, '递归返回', `区间 [${low}, ${high}] 的两个子问题完成，返回上一层。`);
    stack.pop();
  }
  emit(1, '准备开始', '按下下一步，跟随右侧这段 Lomuto 快排代码的完整执行过程。');
  quicksort(0, a.length - 1);
  emit(6, '排序完成', `全部递归返回。共 ${comparisons} 次元素与枢轴比较、${swaps} 次不同下标间的交换；自交换单独展示，不计入交换次数。`);
  return steps;
}
