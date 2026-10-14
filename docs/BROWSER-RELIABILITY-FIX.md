# browser启动/重启与重复失败修复（2026-10-14）

基线 `c88f58d`；修复提交 `ec49c3b`。用户反馈多次browser调用失败，验收期间agent反复尝试。本轮只用隔离Edge和本地合成页面；未操作用户浏览器、未调用真实模型、未全量测试/构建/安装。

## 证据与原因

只读汇总已安装Reed的browser错误11次：9次fetch failed、1次对file URL错误使用navigate（应preview）、1次文件路径无效。不导出用户对话或网页正文。已安装与源码browser.mjs哈希一致，Node均24.15.0；遗留browser-9784/DevToolsActivePort。

新增“启动→关闭→等待退出→再次启动”用例在修复前确定失败：fetch failed，cause=ECONNREFUSED 127.0.0.1旧端口。旧实现每次使用browser-${pid}目录，关闭/60秒空闲退出后DevToolsActivePort仍在；重启的读取循环立即接受旧文件，连接尚不存在/已经关闭的端口。该用例复现了与主要日志相同的失败，但不能断言历史9次每一次都由同一原因造成。

首次默认测试隔离运行还出现进程级失败，仅1项完成且未提供具体原因；改为test-isolation=none时原3项通过，记录为环境/运行器异常，不当作产品通过证据。明确旧端口复现来自新增生命周期用例的ECONNREFUSED。

## 修复

- 每次启动使用全新随机自有profile，只有本次Edge能写入调试端口文件，不接受旧文件。Edge退出后清理该次自有profile；不清理原用户或旧安装profile。
- 启动轮次绑定自有child与generation，取消/关闭时不继续读取失效启动；连接错误附原因码，不再只返回fetch failed。CDP发送失败立即清理pending计时器；页面异常保留首行具体原因。
- learning-tools把AbortSignal传给browser；未开始的已取消操作不启动；活动截图等待及时取消并关闭自有Edge，后续可重新启动。没有替换成另一种隐藏浏览器调用。
- 视觉门控记录本轮browser失败数：连续2次或累计3次后阻止进一步browser工具调用并terminate，不能通过修改HTML或插入成功snapshot绕过。一次纠正成功可恢复；新用户prompt重置。
- 浏览器不可用时停止自动视觉追问，并将结果保留为unverified，不声称视觉验收通过。此限制也覆盖未写网页时的一般browser反复失败。

## 定向验证

12个不同用例通过：browser原3项、关闭重启、取消队列、活动10秒截图等待快速取消及重新启动，共6项；视觉原4项及新增连续失败/累计失败2项，共6项。实际Edge覆盖navigate、preview、snapshot、fill、click、PNG截图、窄屏/整页、来源哈希、旧截图失效和页面跳转来源保护。取消用例要求等待小于1.5秒，不等待10秒延迟。

命令：node --test --test-isolation=none desktop/agent/browser.test.mjs desktop/agent/visual-review.test.mjs（当时11项通过）；新增活动取消后仅复验active screenshot与reopens两项，均通过，不把重复用例重复计数。末次检查未发现测试自有Edge或同项目Node残留。

## 边界与下一步

未重新构建或更新D:\Tools\Reed，已安装应用仍有旧代码；本轮解决源码缺陷。服务侧网页超时、未安装Edge、模型未启用视觉及参数/文件权限错误仍会如实报错，不会被伪造为截图成功。后续可把本次browser及上阶段模型调度一起定向构建并验收原生工具调用；真实Qwen验收保持串行，并行仍实验性。
