# 0.2.2 模型设置与回复生命周期修复

2026-10-14，基线187b989，工作分支0.2.2。用户授权修复全部本轮清单、并行6 Luna、构建与原生验收；所有模拟profile和笔记均为临时合成数据，没有额外调用真实DeepSeek API或改写用户笔记。

## 根因与行为

| 问题 | 代码证据与修复 |
|---|---|
| 回复时设置超时 | 原Bridge串行队列等待整轮session.prompt，设置的30秒计时先到。现在聊天与短命令分离，配置持久化/发现及时反馈，当前任务完成后应用runtime凭据及模型更新。 |
| 停止无效/状态不退出 | 原abort只等待SDK idle，未覆盖Bridge前置准备；前端缺少停止确认状态。现在轮次AbortController覆盖准备、排队、流式fetch；停止立即确认，完成时才释放忙碌状态。 |
| 设置失败污染聊天 | 两窗广播同一Agent事件，原主窗把任何error当当前回复失败。现在用窗口生命周期UUID命令前缀与commandType识别回复，设置失败不隐藏聊天停止按钮。 |
| 保存/发现重试重复提供商 | 新增表单UUID持续用于同一草稿，服务端持久化幂等键并串行相同草稿保存。旧提供商null草稿兼容。 |
| 启动/初始化不稳 | runtime初始化单一Promise，共享初始化完成后才公布；providers.install串行防止临时文件碰撞。 |
| 总览模型切换冲突 | 原start仅按vault root去重，且reasoning固定off。现在root/模型/档位隔离、任务固定模型/认证、取消旧任务后等结束再启动，检查点按内容/模型/档位指纹独立，旧任务不能覆盖状态。 |
| 隐式后台等待 | 启动/连接只恢复已保存总览，不主动生成；用户选择独立模型和档位后生成。纯问候不扫描笔记库，本地扫描支持取消且不清除未检查索引。 |
| 模型选择栏太满 | 旧模型兼容启用；新发现模型默认未选，勾选后才进入主窗/总览选择。禁用当前模型不会阻止重新初始化。 |
| 启动透明窗闪现 | 原重复启动和托盘/快捷键可在ui_ready前直接显示隐藏窗口。增加统一ready门控和带PID/实例身份的Windows属性，未就绪不唤醒；启动日志记录毫秒时序。 |

## 验证与边界

- Agent全量175项：首轮172通过，第二轮174通过；唯一剩余旧夹具的档位/启用顺序修正后，相关16项全部通过。定向44项及后续相关40项已有通过记录，未把复跑次数当独立用例。
- release cargo check和UI-ready门控单测通过。debug cargo check因MSVC c1.dll调试环境失败，未据此改变产品依赖。
- 模拟服务覆盖：首字前/响应头后停滞、停止关闭上游连接、保存及发现不被聊天阻塞、停止后再次对话、禁用模型后init/恢复，完整PI SDK记忆/工具/重启流程。
- fetch分段日志只含请求序号、提供商/模型、阶段、状态码和耗时，不含正文/Key/headers。连接或正文无数据90秒、整次fetch5分钟上限；首body不是首可见回答。
- 官方DeepSeek实际首字延迟尚未重新测量；不能仅凭模拟服务确认用户那次长等待的全部服务端原因。软件队列、取消与界面状态问题独立修复，不把它们归咎模型。
- 已存在总览不覆盖；本轮独立模型选择用于新生成/失败重试，现有文件恢复仍优先。

## 交付进度

源码准备提交。随后构建隔离安装包/便携包，原生验证上述交互与启动时序，最后只推送0.2.2及替换v0.2.2 Draft附件。尚不宣称原生新包已通过，不公开Release。

证据：dist/bugfix-0.2.2-models。focused-first/second/third.log保留失败与旧恢复夹具死锁记录；focused-fourth.log 44项通过；full-agent-first.log、full-agent-final.log保留175项全套结果；provider-final.log最终相关16项通过。

原生阶段：首包57a5e60关键17项通过（native-usability-third.log）；完整桌面在恢复提示检查发现request_phase覆盖recoveryStatus，实际SDK恢复逻辑未丢失，但提示不可持续。已修UI保护，独立提交后重新构建；首包不作为最终交付。两次原生脚本初始化/焦点时序失败日志也保留。

## 最终包验收

最终构建源9bca08d9828cba73defbfb0d3f36db2bbc01a9d3，源码已推送origin/0.2.2；最终目录dist/Reed-0.2.2-model-final，VERSION.json记录相同源提交。最终完整桌面39/39（native-desktop-9bca08d.log）、关键界面17/17（native-usability-9bca08d.log）、NSIS变体窗口10/10（native-window-third-9bca08d.log）通过。窗口前两次输入偏差记录为native-window-9bca08d.log、native-window-retry-9bca08d.log；用户暂不操作鼠标后第三次全过。未绕过窗口归属或落点保护。工具检查6/6、Rust release4/4通过。

| 产物 | 字节 | SHA256 |
|---|---:|---|
| Reed-0.2.2-setup.exe | 50583661 | 625d5a1dc7c47faff5841e8faf526cfe06d9d645dbc0e9f573434f4e69f970f1 |
| Reed-0.2.2-portable.zip | 81190245 | 30b67b9846b97cd1439aca5a03665f837075eb320a673552900b64a564f4af21 |
| SHA256SUMS.txt | 179 | 87a6b694a45a95e8ef32b392f0ac35af368a540651adb711ffaa05cc5dbff180 |

用户最后允许最多2次合成hi、每次256输出token的真实DeepSeek验证。用户确认安装目录D:/Tools/Reed，其启动日志数据目录为%APPDATA%/Reed；只读核对当前和旧profile以及legacy providers.json，仅有Qwen，没有保存的DeepSeek提供商，因此实际付费请求0次。未试用其他服务凭据，未发送真实笔记。官方服务首字延迟仍是未验证项，模拟通过不等于DeepSeek实测通过。

最终产物用于手动安装/便携运行；没有签名私钥，不生成应用内签名更新产物。本轮不安装、不修改main、不公开Release，只替换既有v0.2.2草稿。
