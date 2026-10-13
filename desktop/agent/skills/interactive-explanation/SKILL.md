---
name: interactive-explanation
description: 在Reed中选择原生组件、固定引擎或编写自定义交互式学习作品。
---

# 交互讲解

此能力由角色开关启用，不授予额外权限；当前角色的其他约束继续有效。普通事实和简单提问用文字。当操作、参数变化、预测或比较帮助理解时，设计“观察对象→操作→解释反馈→重置”，聚焦用户困惑。用户明确需要交互时优先尝试。

## 选择路径并按需查资料

- components：组合现有11类原生组件，仅有限JSON状态/数据；读 get_interactive_reference({topic:"components"}) 的schema和9份成功few-shot。此模式不生成JS/HTML/CSS。
- algorithm：固定完整代码执行，支持 quicksort-lomuto-v1、heapsort-max-v1、kmp-prefix-first-v1。版本与用户源码必须相符；只给输入，不编造轨迹。字段/示例同components参考。
- math：quadratic-v1与linear-transform-2d-v1，固定公式和参数；参考同上，不伪造任意函数能力。
- custom：库外需求可编写新的纯计算与SVG组件。先读 get_interactive_reference({topic:"sdk"})，再查 catalog 的实际节点字段；按需读 gradient / queue / policy 完整源码，或 repair 修错指导。不要猜测API，不复制通用按钮、滑块、拖动或保存逻辑。

custom代码使用Reed.register({render,reduce})，只在无DOM/网络/宿主权限的Worker中运行。它可以写新算法/新图形，不是仅选择固定业务模板；但不支持任意DOM/React、Canvas/WebGL或连续动画tick。不存在的能力不能靠提示词实现。关键参数与步骤必须完整声明在状态中；不能依赖闭包跨操作保存。源码/状态/SDK版本随作品保存。

## 交付与修正

generate_learning_ui接收{document:完整JSON字符串,parentArtifactId?:旧作品ID}。不要把源码围栏交给用户自行运行，不把自定义代码放进components或Markdown。custom先真实试运行，启用独立审核时再审核；失败不发布。反馈的stage/message/next/remaining指示下一步；最多修正两次，仍失败就说明限制并回文字，不重复相同失败。仅工具创建成功后才说卡片已展示。

选择输入和参数要有教学依据；明确算法版本、公式、坐标尺度、近似与示例来源。运行/结构/模型审核通过不代表教学事实正确，更不代表用户已掌握。用户调整只是本地操作，不请求模型；有新版本时用parentArtifactId，不覆盖旧作品。缺资料先问或明确标为示例。完整源码和复杂few-shot按需读取，不每轮全部注入。
