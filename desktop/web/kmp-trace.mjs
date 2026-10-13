export const KMP_VERSION='kmp-prefix-first-v1';
export const KMP_CODE=[
  'function kmp(text, pattern) {',
  '  const pi = Array(pattern.length).fill(0);',
  '  let j = 0;',
  '  for (let i = 1; i < pattern.length; i++) {',
  '    while (j > 0 && pattern[i] !== pattern[j]) {',
  '      j = pi[j - 1];',
  '    }',
  '    if (pattern[i] === pattern[j]) j++;',
  '    pi[i] = j;',
  '  }',
  '  if (pattern.length === 0) return 0;',
  '  j = 0;',
  '  for (let i = 0; i < text.length; i++) {',
  '    while (j > 0 && text[i] !== pattern[j]) {',
  '      j = pi[j - 1];',
  '    }',
  '    if (text[i] === pattern[j]) j++;',
  '    if (j === pattern.length) return i - j + 1;',
  '  }',
  '  return -1;',
  '}',
];
export function validKmpInput(input){
  const valid=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/.test(value);
  return !!input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===2&&Object.hasOwn(input,'text')&&Object.hasOwn(input,'pattern')&&valid(input.text,48)&&valid(input.pattern,24);
}
export function createKmpTrace(input){
  if(!validKmpInput(input))throw new Error('文本最多48字、模式最多24字，支持基本多文种字符，不含控制字符或 emoji');
  const {text,pattern}=input,pi=Array(pattern.length).fill(0),steps=[];
  let phase='prefix',i=0,j=0,offset=0,known=pattern.length?1:0,comparisons=0,result=null;
  const emit=(line,action,explanation,comparison=null)=>steps.push({line,action,explanation,phase,i,j,offset,pi:[...pi],known,comparisons,result,comparison,variables:{i,j,offset,result:result??'—'},stack:[{kind:'kmp'}]});
  const compare=(left,right,line)=>{offset=i-j;const a=phase==='prefix'?pattern[left]:text[left],b=pattern[right],equal=a===b;comparisons++;emit(line,'比较字符',`${phase==='prefix'?'pattern':'text'}[${left}] = ${JSON.stringify(a)} 与 pattern[${right}] = ${JSON.stringify(b)} ${equal?'相同':'不同'}。`,{left,right,equal});return equal;};
  const finish=(line,value,explanation)=>{result=value;emit(line,value<0?'未找到匹配':'匹配完成',explanation);steps.at(-1).stack=[];return steps;};
  emit(1,'进入 KMP','先构建 pi 前缀表，再在文本中寻找第一个匹配；索引从 0 开始。');
  emit(2,'初始化前缀表','pi[k] 是 pattern[0..k] 的最长相等真前后缀长度；pi[0]=0。未计算项显示为问号。');
  emit(3,'初始化 j','j 表示当前可复用的前缀长度。');
  for(i=1;i<pattern.length;i++){
    offset=i-j;
    emit(4,'构建前缀表',`处理 pattern[${i}]，当前候选前缀长度 j=${j}。`);
    while(j>0){if(compare(i,j,5))break;const old=j;j=pi[j-1];offset=i-j;emit(6,'前缀回退',`失配：j 从 ${old} 回退到 pi[${old-1}]=${j}，i=${i} 不变。`);}
    if(compare(i,j,8)){j++;offset=i-j+1;emit(8,'扩展前缀',`字符相同，j 增至 ${j}。`);}
    pi[i]=j;known=i+1;emit(9,'写入前缀表',`pi[${i}]=${j}。`);
  }
  emit(11,'前缀表完成',`pi=[${pi.join(', ')}]；现在开始文本匹配。`);
  phase='search';i=0;offset=0;
  if(!pattern.length)return finish(11,0,'空模式串按本实现约定在索引 0 匹配。');
  j=0;emit(12,'开始文本匹配','重置 j=0；失配时只回退 j，文本指针 i 不回退。');
  for(i=0;i<text.length;i++){
    offset=i-j;
    emit(13,'推进文本',`处理 text[${i}]；当前已匹配长度 j=${j}。`);
    while(j>0){if(compare(i,j,14))break;const old=j;j=pi[j-1];offset=i-j;emit(15,'失配回退',`j 从 ${old} 回退到 pi[${old-1}]=${j}；复用已知前后缀，i=${i} 不变。`);}
    if(compare(i,j,17)){j++;offset=i-j+1;emit(17,'扩展匹配',`相同，已匹配长度 j=${j}。`);}
    emit(18,'检查完整匹配',`j=${j}，模式长度=${pattern.length}。`);
    if(j===pattern.length)return finish(18,i-j+1,`第一个匹配起点为 i−j+1=${i-j+1}，文本区间 [${i-j+1}, ${i}]。`);
  }
  return finish(20,-1,'文本已遍历完毕，没有找到完整模式串；返回 -1。');
}
