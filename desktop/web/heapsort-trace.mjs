import { validSortInput } from './quicksort-trace.mjs';

export const HEAPSORT_VERSION = 'heapsort-max-v1';
export const HEAPSORT_CODE = [
  'function heapSort(a) {',
  '  for (let start = Math.floor(a.length / 2) - 1; start >= 0; start--)',
  '    siftDown(a, start, a.length);',
  '  for (let end = a.length - 1; end > 0; end--) {',
  '    [a[0], a[end]] = [a[end], a[0]];',
  '    siftDown(a, 0, end);',
  '  }',
  '}',
  'function siftDown(a, root, size) {',
  '  while (2 * root + 1 < size) {',
  '    let child = 2 * root + 1;',
  '    if (child + 1 < size && a[child + 1] > a[child]) child++;',
  '    if (a[root] >= a[child]) return;',
  '    [a[root], a[child]] = [a[child], a[root]];',
  '    root = child;',
  '  }',
  '}',
];

export function createHeapsortTrace(input) {
  if (!validSortInput(input)) throw new Error('数组需包含 0–12 个 -999 至 999 的整数');
  const a = [...input], stack = [], steps = [], fixed = new Set();
  let size = a.length, comparisons = 0, swaps = 0;
  const emit = (line, action, explanation, marks = []) => steps.push({ line, action, explanation, marks:[...marks],
    array:[...a], stack:stack.map(frame=>({...frame})), variables:{...stack.at(-1),size}, fixed:[...fixed], heapSize:size, comparisons, swaps });
  function siftDown(root, count) {
    const frame = {kind:'siftDown',root,size:count}; stack.push(frame);
    emit(9,'进入下沉',`在有效堆 [0, ${count}) 内，从索引 ${root} 开始下沉。`,[root]);
    while (2 * frame.root + 1 < count) {
      emit(10,'检查孩子',`索引 ${frame.root} 的左孩子存在；左右孩子索引分别为 2×root+1 和 2×root+2。`,[frame.root]);
      frame.child = 2 * frame.root + 1;
      emit(11,'选择左孩子',`child = ${frame.child}，先把左孩子作为候选。`,[frame.child]);
      const rightExists = frame.child + 1 < count;
      const rightLarger = rightExists && a[frame.child + 1] > a[frame.child];
      if (rightExists) comparisons++;
      emit(12,'比较左右孩子',rightExists ? `${a[frame.child+1]} > ${a[frame.child]} 为${rightLarger?'真，选右孩子':'假，保留左孩子'}。` : '右孩子不存在，不读取越界位置，保留左孩子。',rightExists?[frame.child,frame.child+1]:[frame.child]);
      if (rightLarger) { frame.child++; emit(12,'改选右孩子',`child 增至 ${frame.child}，选较大的孩子。`,[frame.child]); }
      comparisons++;
      const ordered = a[frame.root] >= a[frame.child];
      emit(13,'比较父子',`${a[frame.root]} >= ${a[frame.child]} 为${ordered?'真，当前子树已满足大顶堆性质，可返回':'假，需要交换并继续下沉'}。`,[frame.root,frame.child]);
      if (ordered) { stack.pop(); return; }
      [a[frame.root],a[frame.child]]=[a[frame.child],a[frame.root]]; swaps++;
      emit(14,'交换父子',`交换索引 ${frame.root} 与 ${frame.child}，较大值上移。`,[frame.root,frame.child]);
      frame.root = frame.child;
      emit(15,'继续下沉',`root 移到 ${frame.root}，继续检查这棵子树。`,[frame.root]);
    }
    emit(10,'下沉结束',`索引 ${frame.root} 已无有效左孩子，退出循环。`,[frame.root]);
    emit(17,'下沉返回','本次 siftDown 返回，恢复 heapSort。'); stack.pop();
  }
  emit(1,'准备开始','先自底向上建大顶堆，再反复把堆顶最大值交换到数组末尾。');
  const frame={kind:'heapSort'}; stack.push(frame); emit(1,'进入堆排序','数组和树节点使用同一个索引。');
  for (frame.start=Math.floor(a.length/2)-1;frame.start>=0;frame.start--) {
    emit(2,'建堆循环',`start = ${frame.start}，从最后一个非叶节点向根处理。`,[frame.start]);
    emit(3,'建堆下沉',`调用 siftDown(a, ${frame.start}, ${a.length})。`,[frame.start]); siftDown(frame.start,a.length);
  }
  emit(2,'建堆完成','所有非叶节点处理完毕，整个有效区间满足大顶堆性质。');
  for (frame.end=a.length-1;frame.end>0;frame.end--) {
    emit(4,'取出最大值',`end = ${frame.end}；堆顶最大值将放到这里。`,[0,frame.end]);
    [a[0],a[frame.end]]=[a[frame.end],a[0]]; swaps++; fixed.add(frame.end); size=frame.end;
    emit(5,'缩小有效堆',`最大值 ${a[frame.end]} 放到索引 ${frame.end}；它退出树中的有效堆。`,[0,frame.end]);
    emit(6,'恢复大顶堆',`调用 siftDown(a, 0, ${size})，只处理未排序前缀。`,[0]); siftDown(0,size);
  }
  if (a.length) fixed.add(0);
  size=0; emit(8,'排序返回','最后一个元素也就位，所有数组元素已排序。'); stack.pop();
  emit(8,'排序完成',`全部元素有序；${comparisons} 次元素比较、${swaps} 次交换。有效堆已空。`);
  return steps;
}
