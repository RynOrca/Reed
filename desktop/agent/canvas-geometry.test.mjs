import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionGeometry} from '../web/canvas-geometry.js';
test('卡片四周与斜向连接点随相对位置和实际高度改变',()=>{
  const a={x:0,y:0,width:200,height:100};
  for(const [x,y,nx,ny]of [[400,0,1,0],[-400,0,-1,0],[0,300,0,1],[0,-300,0,-1]]){
    const edge=connectionGeometry(a,{...a,x,y});assert.equal(edge.start.nx,nx);assert.equal(edge.start.ny,ny);assert.equal(edge.end.nx,-nx||0);assert.equal(edge.end.ny,-ny||0);assert.doesNotMatch(edge.path,/NaN|Infinity/);
  }
  const diagonal=connectionGeometry(a,{...a,x:400,y:160});assert.notEqual(diagonal.start.y,50);
  assert.notDeepEqual(connectionGeometry(a,{...a,x:0,y:300}).start,connectionGeometry({...a,height:200},{...a,x:0,y:300}).start);
});
