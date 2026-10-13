import { createQuicksortTrace, QUICKSORT_VERSION, QUICKSORT_CODE } from './quicksort-trace.mjs';
import { createHeapsortTrace, HEAPSORT_VERSION, HEAPSORT_CODE } from './heapsort-trace.mjs';
import { createKmpTrace, KMP_VERSION, KMP_CODE, validKmpInput } from './kmp-trace.mjs';

export const EXECUTION_ENGINES = {
  [KMP_VERSION]: {trace:createKmpTrace,code:KMP_CODE,validInput:validKmpInput,strings:true,variables:['i','j','offset','result'],convention:'pi 前缀函数 · 先建表再搜索 · 返回首个匹配起点 · 空模式返回 0 · 索引从 0 开始'},
  [QUICKSORT_VERSION]: {trace:createQuicksortTrace,code:QUICKSORT_CODE,variables:['low','high','pivot','i','j','p'],convention:'Lomuto 分区 · 末尾元素为枢轴 · 严格小于 · 索引从 0 开始'},
  [HEAPSORT_VERSION]: {trace:createHeapsortTrace,code:HEAPSORT_CODE,variables:['start','end','root','child','size'],tree:true,convention:'大顶堆 · 自底向上建堆 · 有效堆区间 [0, size) · 左右孩子 2i+1、2i+2'},
};
