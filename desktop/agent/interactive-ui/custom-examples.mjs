const customBase=(title,question,stateSchema,initialState,script,checks)=>({schemaVersion:1,mode:'custom',sdkVersion:1,stateVersion:1,title,question,source:{kind:'illustrative',label:'自定义组件示例 · 本地计算'},stateSchema,initialState,script,checks});
export function createCustomExample(name='gradient'){
  if(name==='gradient')return customBase('自定义：梯度下降与学习率','观察 f(x)=(x−2)²，改变学习率后逐步更新 x。',{x:{type:'number',min:-1000,max:1000},rate:{type:'number',min:0.01,max:0.9},step:{type:'number',min:0,max:100}},{x:5,rate:0.1,step:0},`Reed.register({
  reduce(s,e){if(e.action==='rate')s.rate=e.value;if(e.action==='position'){s.x=(e.value.x-20)/20-6;s.step=0;}if(e.action==='next'&&s.step<100){s.x=s.x-s.rate*2*(s.x-2);s.step++;}return s;},
  render(s){
    const px=x=>20+(x+6)*20,py=y=>160-y*2;
    const points=Array.from({length:121},(_,i)=>{const x=-6+i*.1;return [px(x),py((x-2)**2)];});
    const d=points.map((p,i)=>(i?'L':'M')+p.join(' ')).join(' ');
    return ui.column([ui.text('更新规则：x ← x − η · 2(x−2)，最小值在 x=2。'),
      ui.slider({label:'学习率 η',min:.01,max:.9,step:.01,value:s.rate,action:'rate'}),
      ui.svg({viewBox:'0 0 280 180',children:[ui.line({x1:20,y1:160,x2:260,y2:160,stroke:'#536b84'}),ui.path({d,fill:'none',stroke:'#8dcaf0',strokeWidth:2}),ui.point({cx:px(s.x),cy:py((s.x-2)**2),r:4,fill:'#efbd72',action:'position',minX:20,maxX:260,minY:0,maxY:160})]}),
      ui.text('横轴 x: −6…6；纵轴 f(x): 0…80，超出视窗裁切。'),ui.text('第 '+s.step+' 步；x='+s.x.toFixed(4)+'；f(x)='+((s.x-2)**2).toFixed(4)),ui.button({label:'迭代一步',action:'next'})]);
  }
});`,[{action:'next'},{action:'rate',value:.5},{action:'next'}]);
  if(name==='queue')return customBase('自定义：循环队列的槽位','入队与出队，观察 head 指向和元素槽位；容量为4。',{items:{type:'array',min:0,max:99,maxItems:4},head:{type:'number',min:0,max:3},value:{type:'number',min:0,max:99},status:{type:'enum',values:['就绪','队满','队空']}},{items:[1,2],head:0,value:3,status:'就绪'},`Reed.register({
  reduce(s,e){if(e.action==='value')s.value=e.value;
    if(e.action==='push'){s.status=s.items.length===4?'队满':'就绪';if(s.items.length<4)s.items.push(s.value);}
    if(e.action==='pop'){s.status=s.items.length?'就绪':'队空';if(s.items.length){s.items.shift();s.head=(s.head+1)%4;}}return s;},
  render(s){const children=[];for(let slot=0;slot<4;slot++){const angle=slot*Math.PI/2-Math.PI/2,x=140+65*Math.cos(angle),y=100+65*Math.sin(angle),index=(slot-s.head+4)%4;
    children.push(ui.rect({x:x-22,y:y-17,width:44,height:34,fill:index<s.items.length?'#37779d':'#16283b',stroke:'#8dcaf0'}),ui.label({x:x-10,y:y+5,text:index<s.items.length?String(s.items[index]):'空'}),ui.label({x:x-20,y:y+32,text:'槽 '+slot}));}
    return ui.column([ui.text('head='+s.head+'，size='+s.items.length+'，tail=(head+size)%4='+((s.head+s.items.length)%4)+'；'+s.status),ui.svg({viewBox:'0 0 280 235',children}),ui.number({label:'入队值',min:0,max:99,step:1,value:s.value,action:'value'}),ui.row([ui.button({label:'入队',action:'push'}),ui.button({label:'出队',action:'pop'})])]);}
});`,[{action:'pop'},{action:'push'}]);
  if(name==='policy')return customBase('自定义：Softmax 策略温度','调整两个动作价值与温度，观察选择概率；这只是策略分布，不是完整强化学习训练。',{q0:{type:'number',min:-5,max:5},q1:{type:'number',min:-5,max:5},temperature:{type:'number',min:.1,max:3}},{q0:1,q1:2,temperature:1},`Reed.register({
  reduce(s,e){if(['q0','q1','temperature'].includes(e.action))s[e.action]=e.value;return s;},
  render(s){const m=Math.max(s.q0,s.q1),a=Math.exp((s.q0-m)/s.temperature),b=Math.exp((s.q1-m)/s.temperature),p=a/(a+b);
    return ui.column([ui.text('π(a)=exp(Q(a)/T) / Σ exp(Q/T)，减去最大值保持数值稳定。'),
      ui.slider({label:'动作0价值',min:-5,max:5,step:.1,value:s.q0,action:'q0'}),ui.slider({label:'动作1价值',min:-5,max:5,step:.1,value:s.q1,action:'q1'}),ui.slider({label:'温度 T',min:.1,max:3,step:.1,value:s.temperature,action:'temperature'}),
      ui.svg({viewBox:'0 0 280 180',children:[ui.rect({x:50,y:150-120*p,width:60,height:120*p,fill:'#8dcaf0'}),ui.rect({x:170,y:150-120*(1-p),width:60,height:120*(1-p),fill:'#8dceb0'}),ui.label({x:45,y:170,text:'动作0 '+p.toFixed(3)}),ui.label({x:165,y:170,text:'动作1 '+(1-p).toFixed(3)})]}),ui.text('概率和=1。只改变采样分布，不改变价值估计或环境。')]);}
});`,[{action:'q0',value:2},{action:'temperature',value:3}]);
  throw new Error('未知自定义示例');
}
