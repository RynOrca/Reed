# 0.2.2全量测试、构建与原生验收（2026-10-14）

## 结论与范围

分支0.2.2，产品修复与构建源为`2be17c1ac9e53ed0f15d9a69cd5d706926b259e8`。全量164项测试通过；最终新包关键功能10项、完整桌面39项、窗口10项和启动画面版式通过。收尾只更新验收脚本与文档，不改变产物中的产品源码。

用户已授权构建、原生验收、全量测试。全部应用验收使用新包、临时profile、合成笔记和本地模拟模型；未修改生产资料，未安装、推送或发布。并行仍标注实验性，未对单槽Qwen并发测试，也未用本轮模拟结果证明真实模型质量或延迟。

## 全量测试

| 套件 | 最终结果 | 日志（工作区dist/migration-0.2.2） |
| --- | --- | --- |
| npm test / Agent | 156通过，0失败，88.127秒 | full-agent-test-final.log |
| review-date与single-slot检查器 | 5通过，0失败 | tool-checkers-final.log |
| cargo test --release --offline | 3通过，0失败 | rust-test.log |

164是不同用例总数，不重复计算复验。Rust首次因生成测试exe的低完整性标签不能创建临时目录；只恢复本工作区生成exe标签后，暴露并行夹具时间戳碰撞。仅cfg(test)增加原子序号修复，生产迁移逻辑未改。最终Agent和检查器在2be17c1再次全量通过。

## 发现并修复

- Windows PowerShell5误读无BOM的中文UTF-8安装脚本、默认编码读取配置JSON：脚本增加UTF-8 BOM，Get-Content显式UTF8，保留原签名/无私钥回退逻辑。
- Rust测试临时目录命名碰撞：测试夹具加入原子序号。
- 原生恢复重试时model_queue覆盖recovery说明：保留恢复说明至实际delta到达，结束/新任务清理。最终完整桌面四种截断/SSE恢复与失败路径通过。
- 最终关键功能验收首次遇到模拟回复固定5秒先结束、阶段提示断言超时：验收脚本等待provider接到请求，检查完回放提示再显式释放回复。仅改验收脚本，原失败记录保留；复验10项全过。

## 最终构建

命令：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/tools/package-installer.ps1 -Output dist/Reed-0.2.2-final`。退出码0，portable与NSIS均完成。ZIP内VERSION.json版本0.2.2、sourceCommit=2be17c1；产物哈希重新计算与SHA256SUMS.txt一致。

| 产物 | 字节数 | SHA256 |
| --- | ---: | --- |
| Reed-0.2.2-setup.exe | 49,999,784 | 791aa679886234f3d5dfeb8242bd022c9e855a621db002e86065cc61f7bdb874 |
| Reed-0.2.2-portable.zip | 81,181,837 | a82bcdb23b57908f04735962f7e1da1bdfde773c799f998eea370a576c506691 |

目录：`dist/Reed-0.2.2-final`。便携Reed.exe SHA256=`5df44fd07b40093fc27a1786c94652c6e9c56450c4cae147d79634d6665b2a60`；NSIS对应原生应用SHA256=`18cabc83bc4642a976f19d9202f459df54e80e6dd39a7924f722b94d6de5ce65`。封装配置使两者不同，分别验收。后者从本次target/release复制至installer-native-final，agent/runtime链接本次最终便携包；未执行安装器。

环境未配置TAURI_SIGNING_PRIVATE_KEY，未生成应用内更新所需签名产物。普通本地安装包构建成功不代表签名更新验收成功。

## 原生验收

| 验收 | 结果与范围 | 最终证据 |
| --- | --- | --- |
| usability-native-acceptance | 10项；实际app_version=0.2.2，pageerror为空，6次模拟模型请求 | native-usability-final.log/json |
| desktop-acceptance | 39项；pageerror为空 | native-desktop-final.log/json |
| window-state-acceptance | 10项；真实鼠标拖拽/边缘缩放、隐藏恢复、退出重启恢复 | native-window-final.log/json |
| splash-check | 版本0.2.2，图标/标题/标语/版本/进度条顺序、无重叠且可视 | native-splash-final.log |

关键功能：启动恢复已保存总览、不重新生成；笔记5→10→12分页；修改模型上下文真实落盘，表单收起且保存反馈可见；并行默认关闭、上限禁用及实验性标注；忙碌重载恢复历史/停止按钮、请求到provider后取消及后续对话。browser通过真实打包Agent工具执行本地HTML预览、窄屏PNG截图，两次tool_end成功且含图片，并非直接绕过工具截图。

完整桌面另覆盖：角色/思考选择（最高medium）、Markdown、模型发现/能力/最大输出、记忆整理和画像证据、笔记原文行号、技能、审批及只读拦截、会话/项目、sidecar中断重启、图片预览、MCP不自动连接、供应商两步删除、四种恢复成功/停止无效重试路径。基础学习目标/画像属于main现有功能，未恢复搁置的交互式学习组件。

窗口最终保存和恢复几何均为x220/y150/1080×860，主题和图标恢复。启动画面检查等待淡出后重新展示以检查版式，不作为真实首屏延迟测量。

已人工查看最终主窗browser完成状态、模型保存反馈、首五篇继续浏览、宽窗和启动画面截图，无遮挡/错位。图片位于dist/desktop-usability及dist/acceptance。保存提示/链接沿用现有浅蓝主题，存在后续提高对比度的空间，本轮未改主题。最后进程核对无本项目测试Node或Reed遗留。

## 失败证据与边界

工作区dist/migration-0.2.2保留：build-first-encoding-failure.log、build-second-json-encoding-failure.log、rust-test-first-failure.log、rust-test-second-fixture-failure.log、native-desktop-first-status-failure.log及截图、first-native-usability.json、native-usability-first-final-timing-failure.log/json。最终build-final.log与各final报告单独保存，不覆盖失败为成功。

本轮授权工作完成。安装/卸载、真实用户资料迁移、签名更新和发布未执行；真实Qwen延迟与实验性并行服务能力不由本轮模拟验收证明。独立检索模型仍为备选，交互式学习继续暂停。
