# Reed 交互学习试验台

独立实验，不修改 Reed 的运行逻辑。Python 3.10+，无需安装依赖。

运行 `python experiments/intelligent-ui-lab/server.py`，访问 http://127.0.0.1:8765 。也可以在本目录运行 `start.ps1`。端口可通过 `UI_LAB_PORT` 环境变量修改，仅绑定本机回环地址。

1. 填写 Base URL（例如 `http://127.0.0.1:8000/v1`）、实际 Model ID、API Key（可空）。
2. 选择思考发送格式与档位。默认不发送，最适合先检查兼容性。
3. 先点击“测试连接”：最多请求 64 tokens 的简短回复，DeepSeek/Qwen 显式关闭思考。连接正常后输入任务并生成；可选择示例。上游采用 SSE，界面实时显示阶段、正文/思考字符数，详情保留完整接收内容；页面预览在生成完成后展示。
4. 点击“修改当前作品”会发送原任务、当前 HTML 与修改要求；“生成交互页面”开始独立任务。
5. 点击记录恢复某一作品的初始页面。源码可以编辑并保存为新版本。导出记录保留 HTML、问题、模型参数、用量与思考，不含 API Key。

## 思考参数

- 不发送：服务自行决定。
- reasoning_effort：发送 minimal/low/medium/high/xhigh/max；关闭发送 none，具体支持由服务决定。
- Qwen：发送 chat_template_kwargs.enable_thinking 布尔值（常见于 vLLM 部署）。
- DeepSeek：发送 thinking.type enabled/disabled；启用时同时发送 reasoning_effort，minimal/low 映射 low，medium/high/xhigh 映射 high，max 映射 max。
- Qwen 格式仅开关，不把 low/high 伪装为服务实际支持的推理强度。模型名称不能保证推理协议，接口报错时先用“不发送”。

使用 `/chat/completions`，输出预算使用 `max_tokens`。支持 SSE 流式响应及兼容 JSON 响应，特殊接口可能需要后续适配。不继承系统代理；如访问云端需要代理，应后续明确配置。

## 边界与验证

API Key 只在页面内存及单次本机代理请求中传递，不写入存储或日志。非敏感连接配置可主动保存到 localStorage。服务拒绝跨来源代理请求，不自动跟随上游重定向。

生成页面以 sandbox iframe 运行，无宿主权限；CSP 禁止联网、嵌套框架和表单提交。要求内嵌脚本与样式，不支持 CDN。显示脚本运行错误。下载的原始 HTML 不再具有测试台施加的隔离策略，直接打开前请检查源码。

记录暂存于页面内存，刷新会清除；导出 JSON 留档（本版不提供导入）。任意组件当前的操作状态不会自动保存或回传给模型，修改要求中需要说明当前参数；这是生成能力试验台，尚非完整教学系统。

测试应比较内容正确性、交互价值、生成耗时与修正次数，不能把“运行成功”当作“知识正确”。自动验证使用模拟接口，不证明真实模型质量。

## 连接故障诊断

测试连接不检查 HTML 生成能力；会产生少量 API 用量。生成中断时保留已收到的正文和思考，不把不完整传输当作成功作品。区分 HTTP 认证/余额/参数/限流错误、IncompleteRead、网络超时与空正文。SSE 处理保活注释、空行和结束标记；静默读取超时120秒，流式总预算10分钟。不自动重试，避免重复计费。实际网络或上游服务中断仍可能发生。

测试命令：`python -m unittest discover -s experiments/intelligent-ui-lab -p test_server.py -v`。9项模拟接口测试及浏览器连接探测、流式生成、按钮运行、断流诊断验证通过；另完成真实 deepseek-flash 简单页面验证：8.7秒、138输出tokens，按钮点击后数字0变1；不代表复杂算法生成质量或持续网络稳定性。
