# dsh-genui / dsh-motion-ui：Reed 移植参考

日期：2026-10-13。用户明确授权两位子代理只读查阅；没有执行外部仓库脚本、安装依赖或复制第三方源码。以下是本次读到的固定版本事实，以及针对Reed的建议，不能把上游宣称的测试当作本次已执行测试。

## 1. 核实仓库，避免同名误用

| 项目 | 本次来源 | 版本 / 提交 |
| --- | --- | --- |
| dsh-genui | [omdsh-dev/dsh-genui](https://github.com/omdsh-dev/dsh-genui) | package 0.12.0；`015b909d8d3485e1716376a60adc5e5b59defa40` |
| dsh-motion-ui | [Scorp1o117/dsh-motion-ui](https://github.com/Scorp1o117/dsh-motion-ui) | package 0.6.0；`906efc00969cb37d31e656d7cab272123c64d032` |

另有 [lhuans/dsh-genui](https://github.com/lhuans/dsh-genui)，是Vue/OpenTiny路线，不能混用其API和示例。Motion UI作者也不是omdsh-dev；它实际vendoring了genui 0.11.4 / `7ff0cf5ea474573a86a912e0cfe938ce8093a66f`的渲染/校验核心，而没有注册上游宿主插件。[上游说明](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/vendor/dsh-genui/NOTICE.md)

## 2. 两者真正的开放程度

**genui是受限JSON + 可信React renderer。** 它有宿主预注册renderer的扩展口，但模型输出未知类型不会自动产生新React实现；没有renderer时返回null。它很适合组件组合、图表和教学表单，并不是“模型即时写新组件代码”的直接范本。[渲染分发](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/src/client/blocks/render-node.tsx)、[宿主适配](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/src/client/primitive-adapter.ts)

**Motion UI有标准层和自由画布层。** render_ui组合原生能力，render_canvas接收模型编写的html/css/script，包装成隔离文档；模型可以直接操作画布内部DOM/SVG，因此确实能做库外组件，但不是向宿主永久注册新renderer。[freeform契约](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/lib/freeform.js)

自由画布的脚本直接在iframe内执行。其来源隔离、CSP、白名单消息值得参考，但README承认没有CPU/内存硬隔离；不能以此替代Reed的可终止Worker边界。[沙箱实现](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/src/sandbox.js)、[README](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/README.md)

Reed的render/reduce机制并不要求业务组件提前存在：模型可以实现新算法、新布局和SVG路径。当前限制来自UI/事件原语：没有任意DOM、Canvas/WebGL、通用手势和连续tick；加更多提示词无法让缺失API自动出现。应明确承认边界，再按真实陌生题扩展少量底层能力。

## 3. 可直接迁移的设计思想

### API目录和分层指导

常驻Skill只保留路由、契约、关键约束；字段目录、完整源码和复杂案例按需读取。genui的Skill包含正反例与场景选择，Motion UI提供catalog与guided/free提示。free改变指导程度，不扩大权限。[genui Skill](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/SKILL.md)、[Motion指导](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/lib/ui-skill.js)

本轮Reed已采纳：get_interactive_reference按需读取SDK和3份完整源码；catalog从真实校验注册表导出节点/props，避免另维护一份会漂移的类型列表。还未新增用户可选guided/free开关，先用默认指导验证质量。

### 模型可执行的修正反馈

genui把验证结果写成status、诊断路径和next动作，限制同回合修复次数，避免重复错误无限循环。[验证工具](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/src/plugin/tool.ts)、[纠错流程](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/src/plugin/fence-feedback.ts)

本轮Reed已采纳：custom失败反馈含stage(protocol/runtime/review)、message、next、attempt、remaining；按同一用户请求限制总共三次尝试，失败不创建已发布作品。后续可增加具体字段路径、错误指纹与独立inspect结果，但不能自动“修正”教学内容后冒称事实正确。

### 宿主控制的动画时间

genui图表使用可信前端推进参数；Motion UI的animate带time/delta/visible/reducedMotion，限制delta，离屏暂停，不补算后台时间。参数可持久化，瞬时动画相位不逐帧写宿主。[PlotBlock](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/src/client/PlotBlock.tsx)、[画布接口](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/lib/sandbox.js)、[正弦示例](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/examples/sine-motion.json)

Reed下一步应设计可信、限频、可取消的tick/播放控制，区分持久参数和瞬时状态。模型只根据dt更新状态，不自己开定时器；后台、折叠、卸载暂停。当前每操作新建Worker并立即终止，不能简单把它以60Hz重复启动称作高性能动画。先测时间预算，再决定连续仿真的Worker生命周期。

### 作品检查、身份与修订

Motion UI有inspect/patch/update与版本冲突概念；genui按会话、位置和内容指纹管理局部状态。[Motion工具说明](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/README.md)、[genui状态存储](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/src/client/interaction-store.ts)

Reed继续使用artifactId、父版本与stateVersion，不照搬覆盖旧作品。下一步提供运行错误、布局溢出、控件标签与当前状态的有限inspect快照；明确点击才围绕选择追问。流式生成时只展示静态且不可执行预览，完整校验后再运行。当前没有渐进预览或任意补丁接口。

## 4. 后续顺序（结合本轮已实现内容）

1. 先交付并定向验证现有custom SDK、状态恢复、真实试运行与独立审核，不继续重复全量验收。
2. 选择库外真实问题做模型验证，记录究竟缺少哪种原语；优先通用pointer/命中区域、受控tick、SVG布局/样式与必要的测量反馈。
3. 做少量跨交互范式示例：拖拽编辑、连续仿真、分步异步计算；避免全部few-shot都是滑块计算器。
4. 若明确需求仍受阻，再评估Canvas绘图命令或独立可杀死的DOM/React执行路径。这是新隔离级别，不是放宽当前白名单即可安全兼容。
5. 临近整体完成时一次大回归；随后做真实本地/云端模型的陌生题矩阵。模拟模型只证明调用链路，不证明生成质量。

## 5. 许可和移植范围

两个项目及Motion内嵌的genui核心为MIT；以后复制实质性源码须保留版权和许可，图表/3D依赖另核许可。[genui许可](https://github.com/omdsh-dev/dsh-genui/blob/015b909d8d3485e1716376a60adc5e5b59defa40/LICENSE)、[Motion许可](https://github.com/Scorp1o117/dsh-motion-ui/blob/906efc00969cb37d31e656d7cab272123c64d032/LICENSE)

本轮仅借鉴架构思想，Reed实现为项目原生代码；没有引入React、DSH宿主路由或远程依赖。独立审核是Reed额外的可选能力，不是这两个项目已证明有效的必要环节。
