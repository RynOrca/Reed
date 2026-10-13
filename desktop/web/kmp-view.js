export function createKmpTracks(input,current){
  const make=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const root=make('div','kmp-view'),prefix=current.phase==='prefix',upper=prefix?input.pattern:input.text,offset=Math.max(0,current.offset);
  root.append(make('h4','',prefix?'阶段 1：构建 pi 前缀表':'阶段 2：搜索首个匹配'));
  const scroller=make('div','kmp-scroll'),width=Math.max(upper.length,offset+input.pattern.length,1);
  const lane=(label,value,shift,isUpper)=>{
    const section=make('div','kmp-lane');section.append(make('p','kmp-label',label));
    const row=make('div','kmp-row');row.style.gridTemplateColumns=`repeat(${width},34px)`;
    for(let index=0;index<value.length;index++){
      const comparison=current.comparison,involved=comparison&&(isUpper?comparison.left:comparison.right)===index;
      const matched=isUpper?index>=offset&&index<offset+current.j:index<current.j;
      const cell=make('div',`kmp-cell${matched?' known':''}${involved?(comparison.equal?' equal':' mismatch'):''}${current.result!==null&&current.result>=0&&matched?' found':''}`);
      cell.style.gridColumn=shift+index+1;cell.append(make('span','kmp-character',value[index]===' '?'␠':value[index]),make('small','',index));
      if((isUpper?current.i:current.j)===index)cell.append(make('b','kmp-pointer',isUpper?'i':'j'));row.append(cell);
    }
    if(!value.length)row.append(make('span','kmp-empty','空串'));section.append(row);scroller.append(section);
  };
  lane(prefix?'模式串（正在计算的位置 i）':'文本（指针 i 不回退）',upper,0,true);
  lane('候选前缀 / 模式串（j 为已匹配长度）',input.pattern,offset,false);
  const table=make('div','kmp-lane');table.append(make('p','kmp-label','pi 前缀表 · 未计算项为 ?'));
  const row=make('div','kmp-row');row.style.gridTemplateColumns=`repeat(${Math.max(1,input.pattern.length)},34px)`;
  current.pi.forEach((value,index)=>{const cell=make('div',`kmp-cell${index<current.known?' known':''}`);cell.append(make('span','kmp-pi',index<current.known?value:'?'),make('small','',index));row.append(cell);});
  if(!current.pi.length)row.append(make('span','kmp-empty','空表'));table.append(row);scroller.append(table);root.append(scroller);
  root.append(make('p','kmp-result',current.result===null?'尚未返回':`返回索引：${current.result}${current.result===-1?'（不存在匹配）':''}`));
  return root;
}
