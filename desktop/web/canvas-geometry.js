// Attach to the card boundary facing its neighbour, regardless of edge semantics.
export function connectionGeometry(a,b){
  const ac={x:a.x+a.width/2,y:a.y+a.height/2},bc={x:b.x+b.width/2,y:b.y+b.height/2};
  let dx=bc.x-ac.x,dy=bc.y-ac.y;if(!dx&&!dy)dx=1;
  function boundary(rect,center,vx,vy){
    const tx=vx?rect.width/2/Math.abs(vx):Infinity,ty=vy?rect.height/2/Math.abs(vy):Infinity,t=Math.min(tx,ty);
    return {x:center.x+vx*t,y:center.y+vy*t,nx:tx<=ty?Math.sign(vx):0,ny:ty<tx?Math.sign(vy):0};
  }
  const start=boundary(a,ac,dx,dy),end=boundary(b,bc,-dx,-dy);
  const bend=Math.min(180,Math.max(24,Math.hypot(end.x-start.x,end.y-start.y)*.4));
  const c1={x:start.x+start.nx*bend,y:start.y+start.ny*bend},c2={x:end.x+end.nx*bend,y:end.y+end.ny*bend};
  return {start,end,path:`M ${start.x} ${start.y} C ${c1.x} ${c1.y},${c2.x} ${c2.y},${end.x} ${end.y}`,label:{x:(start.x+3*c1.x+3*c2.x+end.x)/8,y:(start.y+3*c1.y+3*c2.y+end.y)/8-7}};
}

// Only authenticated exercise edges participate. Ordinary follow-ups stay visible.
export function learningDescendants(graph,id){
  const found=new Set(),pending=[id];
  while(pending.length){const from=pending.pop();for(const edge of graph.edges||[])if(edge.from===from&&edge.kind==='learning_reply'&&edge.explicit&&edge.to!==id&&!found.has(edge.to)){found.add(edge.to);pending.push(edge.to);}}
  return found;
}
export function visibleCanvasNodes(graph){
  if(!graph)return [];const folded=new Set();for(const node of graph.nodes||[])if(node.answersCollapsed)for(const id of learningDescendants(graph,node.id))folded.add(id);
  return (graph.nodes||[]).filter(n=>!n.hidden&&!folded.has(n.id));
}
