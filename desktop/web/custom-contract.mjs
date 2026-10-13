const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,fields)=>plain(v)&&Object.keys(v).every(k=>fields.includes(k));
const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
export function validCustomSchema(schema){
  return plain(schema)&&Object.keys(schema).length<=16&&Object.entries(schema).every(([key,s])=>{
    if(!/^[a-z][a-zA-Z0-9_]{0,31}$/.test(key)||!plain(s))return false;
    if(s.type==='number'||s.type==='array')return exact(s,['type','min','max',...(s.type==='array'?['maxItems']:[])])&&finite(s.min,-1e6,1e6)&&finite(s.max,s.min,1e6)&&(s.type!=='array'||Number.isInteger(s.maxItems)&&s.maxItems>=0&&s.maxItems<=64);
    if(s.type==='boolean')return exact(s,['type']);
    if(s.type==='enum')return exact(s,['type','values'])&&Array.isArray(s.values)&&s.values.length>0&&s.values.length<=20&&s.values.every(v=>typeof v==='string'&&v.length<=80);
    return false;
  });
}
export function validCustomState(schema,state){
  return validCustomSchema(schema)&&plain(state)&&Object.keys(state).length===Object.keys(schema).length&&Object.entries(schema).every(([key,s])=>{
    if(!Object.hasOwn(state,key))return false;const v=state[key];
    if(s.type==='number')return finite(v,s.min,s.max);
    if(s.type==='array')return Array.isArray(v)&&v.length<=s.maxItems&&v.every(n=>finite(n,s.min,s.max));
    if(s.type==='boolean')return typeof v==='boolean';
    return s.values.includes(v);
  });
}
export function validCustomDocument(doc){
  return exact(doc,['schemaVersion','mode','sdkVersion','stateVersion','title','question','source','stateSchema','initialState','script','checks'])&&doc.schemaVersion===1&&doc.mode==='custom'&&doc.sdkVersion===1&&doc.stateVersion===1&&typeof doc.title==='string'&&doc.title.length>0&&doc.title.length<=120&&typeof doc.question==='string'&&doc.question.length>0&&doc.question.length<=300&&exact(doc.source,['kind','label'])&&doc.source.kind==='illustrative'&&typeof doc.source.label==='string'&&doc.source.label.length>0&&doc.source.label.length<=80&&validCustomState(doc.stateSchema,doc.initialState)&&typeof doc.script==='string'&&doc.script.length>0&&doc.script.length<=48000&&Array.isArray(doc.checks)&&doc.checks.length<=6&&doc.checks.every(c=>exact(c,['action','value'])&&typeof c.action==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(c.action)&&JSON.stringify(c.value??null).length<=2048);
}
const props={
  column:['children'],row:['children'],text:['text'],button:['label','action'],
  slider:['label','value','min','max','step','action'],number:['label','value','min','max','step','action'],select:['label','value','options','action'],
  svg:['viewBox','children'],line:['x1','y1','x2','y2','stroke','strokeWidth'],path:['d','stroke','strokeWidth','fill'],circle:['cx','cy','r','stroke','strokeWidth','fill'],rect:['x','y','width','height','stroke','strokeWidth','fill'],polygon:['points','stroke','strokeWidth','fill'],label:['x','y','text','fill'],point:['cx','cy','r','fill','action','minX','maxX','minY','maxY'],
};
const colors=new Set(['none','#8dcaf0','#8dceb0','#efbd72','#ee9797','#ecf4ff','#536b84','#16283b','#37779d']);
export const CUSTOM_UI_CATALOG=Object.freeze(props);
export function validCustomTree(tree){
  let count=0;
  const walk=(node,depth,insideSvg=false)=>{
    if(++count>500||depth>12||!plain(node)||!Object.hasOwn(props,node.type)||!exact(node,['type',...props[node.type]]))return false;
    const graphics=['line','path','circle','rect','polygon','label','point'];
    if(graphics.includes(node.type)!==insideSvg)return false;
    for(const [key,value] of Object.entries(node)){
      if(['type','children'].includes(key))continue;
      if(['stroke','fill'].includes(key)){if(!colors.has(value))return false;}
      else if(key==='options'){if(!Array.isArray(value)||!value.length||value.length>20||value.some(x=>typeof x!=='string'||x.length>80))return false;}
      else if(key==='value'&&node.type==='select'){if(typeof value!=='string'||value.length>80)return false;}
      else if(['text','label','action','viewBox','d','points'].includes(key)){if(typeof value!=='string'||value.length>(key==='d'||key==='points'?12000:1000))return false;if(key==='action'&&!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(value))return false;if(key==='viewBox'&&(!/^[-\d.e+ ]{7,100}$/.test(value)||value.trim().split(/\s+/).length!==4||value.trim().split(/\s+/).some(n=>!Number.isFinite(Number(n)))||value.trim().split(/\s+/).slice(2).some(n=>Number(n)<=0)))return false;}
      else if(!finite(value,-1e6,1e6))return false;
    }
    if(['column','row','svg'].includes(node.type))return Array.isArray(node.children)&&node.children.every(c=>walk(c,depth+1,node.type==='svg'));
    if(['slider','number'].includes(node.type))return typeof node.label==='string'&&typeof node.action==='string'&&finite(node.min,-1e6,1e6)&&finite(node.max,node.min,1e6)&&finite(node.value,node.min,node.max)&&finite(node.step,1e-6,1e6);
    if(node.type==='select')return typeof node.label==='string'&&typeof node.action==='string'&&Array.isArray(node.options)&&node.options.includes(node.value);
    if(node.type==='button')return typeof node.label==='string'&&typeof node.action==='string';
    return true;
  };
  try{return JSON.stringify(tree).length<=100000&&walk(tree,0);}catch{return false;}
}
