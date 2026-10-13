import { createQuicksortTrace, QUICKSORT_VERSION, QUICKSORT_CODE } from './quicksort-trace.mjs';
import { createHeapsortTrace, HEAPSORT_VERSION, HEAPSORT_CODE } from './heapsort-trace.mjs';

export const EXECUTION_ENGINES = {
  [QUICKSORT_VERSION]: {trace:createQuicksortTrace,code:QUICKSORT_CODE,variables:['low','high','pivot','i','j','p'],convention:'Lomuto 分区 · 末尾元素为枢轴 · 严格小于 · 索引从 0 开始'},
  [HEAPSORT_VERSION]: {trace:createHeapsortTrace,code:HEAPSORT_CODE,variables:['start','end','root','child','size'],tree:true,convention:'大顶堆 · 自底向上建堆 · 有效堆区间 [0, size) · 左右孩子 2i+1、2i+2'},
};
