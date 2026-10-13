export function learningSvg(tag,attrs={},text) {
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
  if(text!==undefined)node.textContent=String(text);
  return node;
}
export function createBinaryTree(values,{size=values.length,marks=[]}={}) {
  const svg=learningSvg('svg',{viewBox:'0 0 500 275',class:'learning-tree',role:'img','aria-label':`有效堆二叉树，${size}个节点`});
  if(!size){svg.append(learningSvg('text',{x:250,y:125,'text-anchor':'middle',class:'tree-empty'},'有效堆为空'));return svg;}
  const position=index=>{const level=Math.floor(Math.log2(index+1)),slot=index-(2**level-1);return [500*(slot+.5)/2**level,30+level*65];};
  for(let i=1;i<size;i++){const [x,y]=position(i),[px,py]=position(Math.floor((i-1)/2));svg.append(learningSvg('line',{x1:px,y1:py,x2:x,y2:y,class:'tree-edge'}));}
  for(let i=0;i<size;i++){
    const [x,y]=position(i),group=learningSvg('g',{'data-index':i,class:`tree-node${marks.includes(i)?' involved':''}`});
    group.append(learningSvg('circle',{cx:x,cy:y,r:20}),learningSvg('text',{x,y:y+4,'text-anchor':'middle',class:'tree-value'},values[i]),learningSvg('text',{x,y:y+33,'text-anchor':'middle',class:'tree-index'},`[${i}]`));svg.append(group);
  }
  return svg;
}
let learningPlotId=0;
export function createCartesianPlot({xMin=-6,xMax=6,yMin=-6,yMax=6,label='坐标图',square=false}={}) {
  const height=square?440:335,bottom=30+height;
  const svg=learningSvg('svg',{viewBox:`0 0 500 ${bottom+35}`,class:'learning-coordinate',role:'img','aria-label':label});
  const px=x=>40+(x-xMin)/(xMax-xMin)*440,py=y=>bottom-(y-yMin)/(yMax-yMin)*height;
  const id=`learning-clip-${++learningPlotId}`;
  const defs=learningSvg('defs'),clip=learningSvg('clipPath',{id});clip.append(learningSvg('rect',{x:40,y:30,width:440,height}));defs.append(clip);svg.append(defs);
  const layer=learningSvg('g',{'clip-path':`url(#${id})`});svg.append(layer);
  const line=(x1,y1,x2,y2,cls,parent=layer)=>parent.append(learningSvg('line',{x1:px(x1),y1:py(y1),x2:px(x2),y2:py(y2),class:cls}));
  for(let x=Math.ceil(xMin);x<=xMax;x++){line(x,yMin,x,yMax,x===0?'coordinate-axis':'coordinate-grid');if(x%2===0)svg.append(learningSvg('text',{x:px(x),y:bottom+20,'text-anchor':'middle',class:'coordinate-tick'},x));}
  for(let y=Math.ceil(yMin);y<=yMax;y++){line(xMin,y,xMax,y,y===0?'coordinate-axis':'coordinate-grid');if(y%2===0)svg.append(learningSvg('text',{x:31,y:py(y)+4,'text-anchor':'end',class:'coordinate-tick'},y));}
  const polyline=(points,cls)=>layer.append(learningSvg('polyline',{points:points.map(([x,y])=>`${px(x)},${py(y)}`).join(' '),class:cls,fill:'none'}));
  const point=(x,y,cls,text,offset=[8,-9])=>{layer.append(learningSvg('circle',{cx:px(x),cy:py(y),r:5,class:cls}));if(text)layer.append(learningSvg('text',{x:px(x)+offset[0],y:py(y)+offset[1],class:'coordinate-label'},text));};
  const vector=(x,y,cls,text,offset)=>{line(0,0,x,y,cls);const angle=Math.atan2(py(y)-py(0),px(x)-px(0)),tx=px(x),ty=py(y);if(Math.hypot(x,y)>1e-8)layer.append(learningSvg('polyline',{points:`${tx-10*Math.cos(angle-.45)},${ty-10*Math.sin(angle-.45)} ${tx},${ty} ${tx-10*Math.cos(angle+.45)},${ty-10*Math.sin(angle+.45)}`,class:cls,fill:'none'}));point(x,y,cls,text,offset);};
  return {svg,layer,line,polyline,point,vector,px,py};
}
