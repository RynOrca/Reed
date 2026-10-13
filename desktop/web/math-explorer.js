import { MATH_SPECS, validMathState, quadraticValues, linearValues } from './math-models.mjs';
import { learningSvg, createCartesianPlot } from './learning-svg.js';

export function createMathExplorer(documentData,savedState,onChange) {
  const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
  const kind=documentData.math,quadratic=kind==='quadratic-v1';
  let state={...(validMathState(kind,savedState)?savedState:documentData.initialState)};
  const root=make('div','math-explorer'),plotHost=make('div','math-plot-host'),controls=make('div','math-controls');
  plotHost.classList.toggle('probe-enabled',quadratic);
  const formula=make('strong','math-formula'),details=make('p','math-details'),hint=make('p','algorithm-convention');
  const values=new Map(),inputs=new Map();
  const persist=()=>onChange({...state});
  const update=(key,value,commit=false)=>{
    const next={...state,[key]:value};
    if(!validMathState(kind,next))return false;
    state=next;render();if(commit)persist();return true;
  };
  const labels=quadratic?{a:'开口系数 a',h:'水平平移 h',k:'竖直平移 k',x:'探查位置 x'}:{a:'矩阵 a（第1行第1列）',b:'矩阵 b（第1行第2列）',c:'矩阵 c（第2行第1列）',d:'矩阵 d（第2行第2列）',vx:'向量 x',vy:'向量 y',t:'变换进度 t'};
  const matrix=make('div','math-matrix');
  if(!quadratic){const header=make('p','interactive-node-label','目标矩阵 A（按行排列）');controls.append(header,matrix);}
  for(const [key,[min,max]] of Object.entries(MATH_SPECS[kind])){
    const isMatrix=!quadratic&&['a','b','c','d'].includes(key);
    const label=make('label',isMatrix?'math-matrix-entry':'math-control');
    const title=make('span','',labels[key]);
    const input=make('input');input.type=isMatrix?'number':'range';input.min=min;input.max=max;input.step='0.1';input.setAttribute('aria-label',labels[key]);
    const output=make('output');inputs.set(key,input);values.set(key,output);
    input.oninput=()=>{if(input.value!=='')update(key,Number(input.value));};
    input.onchange=()=>{if(input.value===''||!update(key,Number(input.value),true)){input.value=state[key];input.setCustomValidity('请输入范围内的数字');input.reportValidity();}else input.setCustomValidity('');};
    label.append(title,input,output);(isMatrix?matrix:controls).append(label);
  }
  const reset=make('button','interactive-reset','恢复初始参数');reset.type='button';reset.onclick=()=>{state={...documentData.initialState};render();persist();};
  const layout=make('div','math-layout');layout.append(plotHost,controls);
  hint.textContent=quadratic?'拖动图中的水平位置或调节滑块；曲线超出纵轴 −8…8 的部分会被裁切。a=0 时退化为常数函数。':'橙色：变换前向量；白色：当前变换后向量；蓝/绿：当前基向量；填色四边形表示单位正方形的像。网格超出视窗部分裁切。';
  root.append(make('p','interactive-question',documentData.question),formula,layout,details,hint,reset);
  const fmt=value=>{const rounded=Math.abs(value)<1e-8?0:value;return Number(rounded.toFixed(3)).toString();};
  function render(){
    for(const [key,input] of inputs){if(input.type!=='number'||document.activeElement!==input)input.value=state[key];values.get(key).textContent=fmt(state[key]);}
    const plot=createCartesianPlot({xMin:-6,xMax:6,yMin:quadratic?-8:-6,yMax:quadratic?8:6,square:!quadratic,label:quadratic?'二次函数、顶点与探查点切线':'二维线性变换坐标网格与向量'});
    if(quadratic){
      const q=quadraticValues(state);
      formula.textContent=`y = ${fmt(state.a)}(x − ${fmt(state.h)})² + ${fmt(state.k)}`;
      plot.polyline(Array.from({length:241},(_,i)=>{const x=-6+i*.05;return [x,q.at(x)];}),'function-curve');
      plot.line(-6,q.y+q.slope*(-6-state.x),6,q.y+q.slope*(6-state.x),'function-tangent');
      plot.line(state.x,-8,state.x,8,'function-probe-line');
      if(state.a!==0)plot.point(state.h,state.k,'function-vertex','顶点');
      plot.point(state.x,q.y,'function-probe','P');
      details.textContent=`P = (${fmt(state.x)}, ${fmt(q.y)})；切线斜率 y′ = 2a(x−h) = ${fmt(q.slope)}。${state.a===0?'a=0：这是水平常数函数，没有唯一顶点。':`顶点 (${fmt(state.h)}, ${fmt(state.k)})，开口${state.a>0?'向上':'向下'}。`}`;
    }else{
      const result=linearValues(state),tx=result.transform;
      for(let i=-3;i<=3;i++){plot.polyline([tx(i,-3),tx(i,3)],'transform-grid');plot.polyline([tx(-3,i),tx(3,i)],'transform-grid');}
      const square=[[0,0],[1,0],[1,1],[0,1]].map(([x,y])=>tx(x,y));
      plot.layer.append(learningSvg('polygon',{points:square.map(([x,y])=>`${plot.px(x)},${plot.py(y)}`).join(' '),class:'transform-area'}));
      plot.vector(...tx(1,0),'transform-basis-x','e₁',[8,18]);plot.vector(...tx(0,1),'transform-basis-y','e₂',[-21,-12]);
      plot.vector(state.vx,state.vy,'transform-original','v',[8,-12]);plot.vector(...result.vector,'transform-vector','B(t)v',[8,18]);
      formula.textContent=`A = [${fmt(state.a)}  ${fmt(state.b)}; ${fmt(state.c)}  ${fmt(state.d)}]，B(t) = (1−t)I + tA`;
      details.textContent=`目标 Av = (${result.targetVector.map(fmt).join(', ')})；当前 B(t)v = (${result.vector.map(fmt).join(', ')})。det A = ${fmt(result.determinant)}，目标面积缩放 |det A| = ${fmt(Math.abs(result.determinant))}；当前 det B(t) = ${fmt(result.currentDeterminant)}。${Math.abs(result.determinant)<1e-8?'目标矩阵奇异，单位正方形被压成线或点。':result.determinant<0?'目标变换反转方向。':'目标变换保持方向。'} 插值是观察过程，不表示所有中间矩阵都可逆。`;
    }
    plotHost.replaceChildren(plot.svg);
  }
  if(quadratic){
    let dragging=false;
    const setProbe=event=>{const rect=plotHost.querySelector('svg').getBoundingClientRect(),viewX=(event.clientX-rect.left)/rect.width*500;update('x',Math.round(Math.max(-5,Math.min(5,-6+(viewX-40)/440*12))*10)/10);};
    plotHost.onpointerdown=event=>{dragging=true;plotHost.setPointerCapture(event.pointerId);setProbe(event);};
    plotHost.onpointermove=event=>{if(dragging)setProbe(event);};
    plotHost.onpointerup=event=>{if(!dragging)return;setProbe(event);dragging=false;persist();};
    plotHost.onpointercancel=()=>{if(dragging){dragging=false;persist();}};
  }
  render();return root;
}
