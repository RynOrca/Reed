# ReedUI v1：编写新的作品组件

这是实际接口参考，不是任意HTML运行器。生成前先读取本文件，再按需要读取 gradient / queue / policy 完整示例。代码在无 DOM 的 Worker 运行，必须使用 `Reed.register({render(state),reduce(state,event)})`；不要使用 window/document/fetch/定时器/导入依赖。所有渲染和事件计算需在1500ms内结束。实现新计算函数和新SVG图形即可创建库外作品；通用控件由Reed实现。

`get_interactive_reference({topic:"catalog"})` 返回从实际校验注册表导出的节点/字段清单。失败反馈含 status、stage(protocol/runtime/review)、message、next、attempt、remaining；按 fix_and_revalidate 修正，explain_failure 时停止并说明。不要重复同一报错。

## 文档

`{schemaVersion:1,mode:"custom",sdkVersion:1,stateVersion:1,title,question,source:{kind:"illustrative",label},stateSchema,initialState,script,checks}`。最多64KiB文档，script最多48000字符。source用于示例来源，不得谎称已验证。stateSchema最多16键，键名字母开头仅字母数字下划线。每键可为：

- `{type:"number",min,max}`：有限数，范围在 ±1e6。
- `{type:"boolean"}`。
- `{type:"enum",values:[字符串...]}`：最多20个，每个最多80字符。
- `{type:"array",min,max,maxItems}`：最多64个有界数字。

initialState和reduce返回状态必须恰好包含全部声明键。不要存DOM/函数/闭包；组件源码、参数与步骤会随作品保存，重开时重新render。checks最多6个 `{action,value?}`，描述需要试运行的操作；不是事实正确性断言。发布前会真实运行初始渲染和这些操作，错误返回给你。修正最多两次，不宣称模型自测就是通过。

## 生命周期

`render(s)` 为纯视图计算，返回一棵 ui 树；`reduce(s,{action,value})` 接收状态副本并返回完整新状态。在函数内编写自定义算法、坐标布局、数值计算；不访问宿主。重置由宿主提供，无需自己写保存或消息桥。按钮/滑块普通操作不向模型发请求。每个事件名称只含字母数字下划线，字母开头、最长40字符。

每次操作重新创建Worker、加载源码；返回有效结果后立即终止。不要依赖闭包或全局变量跨操作保存数据，关键数据必须在声明状态内。Worker定时器不可用；连续动画的受控tick尚未开放，不伪造支持。

## UI API

- `ui.column([节点...])`，`ui.row([节点...])`，`ui.text(字符串)`。
- `ui.button({label,action})`。
- `ui.slider({label,min,max,step,value,action})` / `ui.number(...)`；用户确认后event.value是数字。
- `ui.select({label,options:[字符串...],value,action})`；event.value是字符串。
- `ui.svg({viewBox:"0 0 400 240",children:[图形...]})`。viewBox必须是4个有限数，宽高>0；坐标和计算自行设计，图外部分裁切。
- `ui.line({x1,y1,x2,y2,stroke,strokeWidth?})`。
- `ui.path({d,fill,stroke,strokeWidth?})`，d是SVG路径字符串，最多12000字符。
- `ui.circle({cx,cy,r,fill,stroke?,strokeWidth?})`。
- `ui.rect({x,y,width,height,fill,stroke?,strokeWidth?})`。
- `ui.polygon({points,fill,stroke?,strokeWidth?})`，points是SVG点串，最多12000字符。
- `ui.label({x,y,text,fill?})`。
- `ui.point({cx,cy,r,fill,action,minX,maxX,minY,maxY})`：可拖动，方向键每次移动1坐标单位；释放/按键时event.value为 `{x,y}`，转换为你声明的数值状态，不要把该对象直接放进数字字段。

最多500节点、12层、100KB树。仅以上props；没有任意HTML、CSS、URL、事件函数或innerHTML。颜色仅：`none`、`#8dcaf0`、`#8dceb0`、`#efbd72`、`#ee9797`、`#ecf4ff`、`#536b84`、`#16283b`、`#37779d`。统一主题、布局、按钮/滑块/输入/拖动由SDK负责，不复制这些实现。SVG节点只能放svg.children中。

## 质量与修正

先说明用户应通过什么操作观察什么关系，再选择状态、计算函数与图形。对空输入、极值、退化情况给反馈，区别采样点和连续函数、概率和价值。显示必要公式、坐标尺度与简化范围。不要硬编码假的算法轨迹。

典型修正：render返回字符串 → 改成 ui.text；状态少键 → 返回完整s；未知SVG属性/颜色 → 查本文；无穷循环 → 限制迭代并分步；恢复后图不一致 → 把关键参数声明进stateSchema。

现有components/algorithm/math合适时优先使用；版本不符时不要冒充原题代码。仅当新逻辑/视图需要时写custom。独立审核可能要求修正；它的结论不替代运行或事实核对。工具返回创建成功后再说已展示；失败则解释并回文字。
