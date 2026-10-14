# Reed 0.2.2：交给 DeepSeek 的 bug 修复交接

交接日期：2026-10-14（Asia/Shanghai）。这是进行中的修复交接，**四项用户问题均未完成本轮验收**。当前代码包含尚未充分验证的 WIP；请先审查，不要当作已修复版本。用户最新要求是转交 DeepSeek，本 Agent 停止继续开发，只保全现场和整理资料。

## 1. 用户目标、优先级和授权

用户反馈基础交互修了两天仍不可用，对重复验收但真实场景仍失败非常不满。应以真实触发条件和可复现证据推进，少泛化承诺。

已确认执行顺序：

1. **停止失效**：问“我有什么要复习的吗”，模型 DeepSeek-V4.1-Flash，medium。点击停止一直“正在停止…”→“正在停止，等待请求结束…”→红色“操作超时，请检查 Agent 连接”，界面仍等待。必须定位停止命令、事件循环、网络/工具取消及轮次结束，而不是只提前把 UI 设空闲。
2. **笔记库总览仍超时**：同一官方 DeepSeek 主对话能成功，但总览在 medium 失败。截图提示已保存完成批次，重试继续；实际失败在哪个阶段尚未证实。
3. **主对话查本地笔记很慢**：测量扫描/索引、FTS、模型扩词、排队、响应头/首数据/首正文；解释总览缺失的影响及向量/RAG 的价值，不先引入向量库。
4. **笔记卡片**：宽窗口三列，统一行列间距，窄窗口合理两列/一列；去除开头 YAML frontmatter 后显示正文，最多五行。保留每批五篇，调整数量要先讨论。

用户明确要求：**全部修完再统一构建和测试；中途只做必要定向验证，不每项都全量测。** 同一已确认计划不要重复索要确认。计划需持续写入项目文件，每项成果独立 commit，CHANGELOG 仅最近十条并记录 hash。不能重启就当修好，不能拿旧轮通过担保本轮。

真实模型调用：旧轮最多两次付费 hi 请求已用完；新的付费调用，尤其发送真实笔记，需重新取得明确授权。当前只允许隔离合成资料/本地模拟服务。不要索要用户把 Key 贴到聊天。

进程：用户本轮明确授权关闭核对过的 `D:/Tools/Reed/Reed.exe` PID 19824 和 `D:/Tools/Reed/runtime/node.exe` PID 19652，已通过提权命令关闭；交接只读检查未见该路径进程。不代表将来新进程可自动杀。每次启动项目 Node 若发现已有同项目 Node，先询问；不要杀 Codex/CUA 等辅助进程。

## 2. 仓库、版本和资料入口

- 仓库：`D:/Code/Working-on-it/summon-4-pi`，分支 `0.2.2`。
- 本轮原基线：`092388c7cdd0b65e420d9b2de202133c6d5b2928`。此前已推 origin/0.2.2。
- 本轮计划提交：`00c38c27a24a706d6ad62148c592d40073ff64aa`。
- main 保持 `9fb92bbe0f1622fff86a98244f0a5d7301a1b912`，不得修改。
- 本轮 WIP 和交接提交见末尾“保全记录”，接手先运行 `git status --short`、`git log -4 --oneline`。本轮尚未推送、构建或更新 Release。
- 项目计划：`PLAN-0.2.2.md` 末尾“新轮基础交互修复”。旧轮报告：`docs/BUGFIX-0.2.2-MODEL-LIFECYCLE.md`。
- 本地参考源码：`D:/Code/Working-on-it/PI-Desktop-src`。只读参考，不修改这个仓库。它的规则不应被误套到 Reed。
- 用户截图已从临时目录复制到 `docs/handoff-deepseek-2026-10-14/`：`stop-pending.png`、`stop-timeout.png`、`overview-timeout.png`、`note-preview.png`，接手先查看。
- 本项目原根目录没有 AGENTS.md、RTK.md。此次新建最小 AGENTS.md 承载用户已给出的规则；RTK.md 仍未找到。

## 3. 已证实的性能问题与测试证据

本轮新增 `desktop/tools/vault-performance.mjs`。它在 OS 临时目录生成 400 篇合成 Markdown，每篇 12 个主题段落；创建独立 CapabilityStore，依次查询冷、暖、重复检索，并每 10 ms 测量事件循环滞后。只删除该脚本自身 mkdtemp 目录，不碰真实笔记。

在本轮代码修改前启动的进程加载的是旧版 capabilities/local-search（运行期间源码有改动，但进程已加载旧模块）。命令：

```powershell
node desktop/tools/vault-performance.mjs 400
```

原始输出：

```jsonl
{"label":"cold","count":400,"hits":6,"ms":180692,"maxEventLoopLagMs":1053}
{"label":"warm","count":400,"hits":6,"ms":14527,"maxEventLoopLagMs":14477}
{"label":"repeat","count":400,"hits":6,"ms":14461,"maxEventLoopLagMs":14402}
```

这是合成资料、当前命令环境下的基线，不是用户真实库耗时；文件系统/沙箱会影响绝对值。**新版性能尚未复测，不能写性能提升百分比。** 暖查询的严重同步阻塞已复现，支持“检索可阻塞停止接收”的机制假设，但尚不能单凭此认定用户这次停止失效的唯一根因。

旧实现每次 searchNotes 都全库 readdir/lstat、权限检查、逐文件在 FTS UNINDEXED 元数据列查段落，逐段落 find 查重，缺少普通 B-tree 索引，且同步 SQLite 写入/清理。可产生近似二次查表和事件循环长时间占用；即使内容没变，每次仍重扫。

定向测试运行在最后一批 bridge/overview/UI 修改**之前**：

```powershell
node --test --test-isolation=none desktop/agent/local-search.test.mjs desktop/agent/stream-diagnostics.test.mjs desktop/agent/request-lifecycle.integration.test.mjs
```

结果：12 项中 10 项通过（本地搜索 5、请求诊断 5）；两项 request-lifecycle 集成测试在 spawn 子 Agent 时 `EPERM`，没有进入产品路径，**不能算通过，也不能直接说产品失败**。需用合适权限重新执行。没有运行新版性能、全量、构建、原生 UI 或真实 DeepSeek。最后一次 apply_patch 已完成，之后用户中断转交。

## 4. 当前 WIP 改了什么、必须审查什么

这些均是未验收草稿，可改写或回退，不能为了保住本 Agent 的方案绕过失败。

| 文件 | WIP 内容 | 接手重点/风险 |
|---|---|---|
| `desktop/agent/local-search.mjs` | 新普通表 search_metadata 和 `(area,scope,id)` 索引；查重改查 metadata；put 用 savepoint 原子更新 FTS+元数据；remove/retain 同步维护两表，新增 transaction | **迁移目前用“表是否存在”判已迁移，建表与回填没有同一原子事务，进程中断可能留下空/不全元数据。必须审查并补可靠迁移。** 所有消费者 work-memory 等共享此类；旧库迁移、两表一致性、重复 id/scope、rollback、并发/重开均需验证。retain 大批删除仍同步，可能长阻塞；put 前查重也在 savepoint 外。SQLite 不允许 virtual table triggers，当前使用显式更新，不要补不支持的 trigger。 |
| `desktop/agent/capabilities.mjs` | 一次读所有 notes revisions，内存按文件前缀分组；每文件/每 32 条写入之间 yield setImmediate，批量 transaction；记录 scan/index/FTS/totalMs；新增 noteBody 去开头完整 YAML；浏览截取正文 1200 字 | 仍每次全扫，未引入 watcher/cache；构造待写数组和 retain/迁移仍有同步段。取消扫描不得 retain 删除未检查索引；权限变化不得复用陈旧证据；引用行号必须保持原文。noteBody 仅用于 browseNotes，**搜索结果卡片尚未去 frontmatter**。只截 1200 字是否覆盖五行要检查。 |
| `desktop/agent/stream-diagnostics.mjs` | fetch 与 abort promise 竞争；取消时立即 error 包装 ReadableStream；reader.cancel 不再等待 | **fetch 在取消后才返回 response 的情况还没清理迟到 body，需补释放。** 检查 abort 与 start/pull 竞态、已 error/closed 的二次 error、未处理拒绝/监听器/计时器泄漏，以及 socket 实际关闭。不要只释放本地额度却让本地 Qwen继续并行。 |
| `desktop/agent/bridge.mjs` | 辅助请求转发请求阶段；overview 显式 requestTimeout 决定 fetch idle/total（最多五分钟）；停止先 ack/stopping 再 abort；controller 保存 promptId、拒绝过期停止；取消后忽略部分迟到输出 | **最后一批未测试。** stale ack 返回后前端未处理 stale，可能留 stopping；无当前任务时停止也要有终态。ack 提前不能当停止已结束。仍需追真实生命周期和工具/压缩/prepareSkills/context hook。不应依赖全局 controller 隔离脱离任务；目前没有安全脱离/重建 session 实现。 |
| `desktop/web/app.js` | abort 携带 activePromptId | 查广播、ack、stopping/session_sync/done、命令超时恢复与迟到事件的轮次边界。当前 stale ack 未处理；不要让旧 done 关闭新轮 UI。 |
| `desktop/agent/vault-overview.mjs` | off 1800；启用思考尝试增加预算（minimal+1024/low+2048/medium+8192），受模型 maxTokens 上限约束；length 提示明确；阶段回调显示状态；checkpoint 增加按 text+system hash 缓存 stages，保留原 batches fingerprint v3；压缩组目标由14000降6000 | **所有新逻辑未测试。预算只是候选，不是官方 DeepSeek 超时根因结论，增加预算可能增加耗时/费用。** 确认 SDK/模型总 token 语义和真实输出限制。单个摘要最多13000，仍可能超过6000组目标；最终汇总仍可14000。阶段缓存量、旧v3兼容、换模型/档位/笔记后的隔离、取消和崩溃恢复、安全写入都需验证；完成批次计数现在仍有 reduced summaries 误报风险。 |
| `desktop/web/settings.css` | browse/results 三列，1000px两列、660px一列，gap14，卡片padding16无margin | 尚未视觉验收。默认设置窗含侧栏，按总窗宽断点可能卡片太窄，应测实际内容宽度；五行、长路径、空结果/按钮位置/分页都需检查。 |
| `desktop/tools/vault-performance.mjs` | 可重复的合成性能测试 | 只跑了旧版基线；下次同环境同规模复测并保存原始结果。 |

## 5. 下一步路线（按证据修复，不强行接受 WIP）

### 停止与性能优先

先检查普通元数据迁移和批处理正确性，复测 400 篇暖查询与 event loop lag。针对更大库、大文件、删除/重命名/权限拒绝、取消扫描验证。若全扫仍拖慢，考虑增量索引/扫描节流/监听，但不要以缓存牺牲权限和内容新鲜度。必要时将重索引放 worker；避免把耗时 SQLite 同步段塞主 Agent 事件循环。

停止链路逐段追：`app.js stop-button` → Rust `agent_command` stdin → `bridge.mjs` readline 高优先级 abort → turnController/SDK session.abort → context hooks / tools / modelRequests / fetch → prompt finally → busy=false/session_sync/done。要分别量化 ack 时间和真正结束时间。

关键复现：连接无响应、响应头已到但无 body、只思考无正文、流中停滞、排队（后台总览占槽）、初次大库索引/暖查询、工具执行及压缩前置阶段。验证取消后的 socket/额度、能发送下一条、旧输出不串入新回复。服务端不配合取消与本地任务可用性必须明确分开，不能假装上游已停。

本地 pi-desktop 可参考：

- `packages/host-runtime/src/runtime-service.ts` 约426行：abort 在第一个 await 前锁定 aborted reason，finally 用 turnId 结束指定轮次。
- 同文件 `lockAbortReason`、`finishTurn` 的幂等/迟到终态逻辑；`runtime-service.test.ts` 对迟到 agent_end 不覆盖 aborted 的用例。
- `apps/desktop/electron/main/agent-host-bridge.ts` 的 abortingSessions/turn interrupted；sidecar tools.abort 传递。

这些仅是已只读查看的参考点，尚未完成对照或移植。不要整仓库照抄，只借鉴明确轮次身份、控制通道、幂等终态与资源收尾。

### 总览定位

旧版每份读 headings≤1200字 + 正文前2500字，每批6000字符，排队五分钟+请求五分钟，maxTokens1800，reasoning使用独立选择；摘要合并超过14000时分层压缩，再最终汇总。SDK本地源码确认 `openai-completions` 的 explicit maxTokens 直接进 max_tokens/max_completion_tokens，DeepSeek thinkingFormat 控制 thinking.enabled；不能仅凭 medium 名称假定具备独立可控思考 token 预算。

优先诊断第几批/压缩哪组/最终汇总、输入字符/估算tokens、maxTokens、排队/响应头/首数据/首正文/结束、stopReason。日志不得包含 Key、完整提示词、笔记正文。检查后台和主对话共享串行地址额度是否互阻。模拟长思考、length、超时和中断，验证每个已完成阶段恢复、不重复付费重跑。不要盲目增大 timeout；真实官方调用必须另获授权。

### 检索与向量解释

当前是本地 SQLite FTS + 可选模型扩词，没有 embedding。`learning-tools.mjs context_with_system` 前置检索 `expand:false`，纯问候才跳过；`search_notes` 工具默认可扩词，5秒预算、off、max1024，至多3查询，每次都可能重新扫描。主对话每次 provider context hook 是否重复自动查同一问题也需量化。

没有总览不会关闭 FTS；会少导航信息，模型可能增加探索工具调用。向量/混合检索能改同义词、语义召回，不能修 event loop、HTTP超时、取消或队列阻塞。先修现有路径、量化后提出可选增强，不擅自新增向量库/embedding费用。

## 6. 统一验收与构建

先必要定向用例，所有功能改完后一次完整 Agent/Rust/工具检查、统一构建，再对**同一构建源**做隔离原生验收。若发现新bug，定向修复后重建受影响产物，不能用旧包验新源。不要重复无关全量测试消耗用户时间。

相关测试：`local-search.test.mjs`、`stream-diagnostics.test.mjs`、`request-lifecycle.integration.test.mjs`、`model-request.integration.test.mjs`、`model-requests.test.mjs`、`vault-reliability.test.mjs`、`learning-workspace.test.mjs`、`note-retrieval` 相关用例和 `provider-flow.test.mjs`。新增真实行为用例要包含忽略 abort 的 fetch/reader，以及大库索引时 abort ack/done。

```powershell
# 完整 Agent（统一收尾时）
npm test
# Rust，先确认工具链/权限；不要把环境错误改成产品通过
cargo test --manifest-path desktop/src-tauri/Cargo.toml
# 安装包脚本内部会准备 portable staging，避免无意义重复构建
powershell -NoProfile -ExecutionPolicy Bypass -File desktop/tools/package-installer.ps1 -Output dist/Reed-0.2.2-vault-stop-final
```

脚本细节以当前源码为准，先看 `package-portable.ps1`、`package-installer.ps1`。构建可写新目录，不覆盖旧验收包。原生脚本：`desktop-acceptance.cjs`、`usability-native-acceptance.cjs`、`window-state-acceptance.cjs`、`vault-ui-acceptance.cjs`。它们依赖各自顶部说明/env，通常 `SUMMON_TEST_PACKAGE` 指新 portable 包，`SUMMON_TEST_DATA_DIR`/WebView2隔离资料；先读脚本，别猜参数。`isolated-package.cjs` 负责隔离新包，不能拿生产 profile 做测试。

命令沙箱有 Windows 权限限制：git写 .git、Stop-Process、Node spawn 可能 Permission denied/EPERM；此前必要命令用 require_escalated通过。遇到错误应保持证据、走宿主允许的权限路径，不改测试绕过，不关闭证书校验。此次两个 spawn EPERM 还没提权复验。

## 7. 旧轮成果与生产配置坑（防重复踩）

旧轮已实现：长prompt不占设置短命令队列；准备/排队/fetch取消传递；runtime单次初始化；保存提供商草稿幂等/模型勾选；总览独立模型思考、固定凭据与检查点；启动只恢复已有总览，不隐式生成；UI-ready显窗。但**源码存在不代表本轮可用**。

旧轮175独立Agent用例通过的表述：全套与原失败定向复验组成，不能说一次最终175/175。旧最终包39完整桌面+17关键界面+10NSIS窗口=66通过；从未真实测 medium总览或真实笔记检索。

官方DeepSeek旧轮仅两次off合成hi，各max_tokens256：直连首字1.627s/完成1.747s，10输出token；包内隔离Agent首字1.730s/接口完成2.196s/整轮2.506s，65输出token、busy清除。Agent输入5573token、直连5token，不能把差值当纯软件开销。额度已耗尽。

**实时配置文件视图差异**：命令工具读取 `%APPDATA%/Reed/user-config.json` 曾看到Oct12旧Qwen；原生资源管理器和设置显示Oct14已有DeepSeek。路径、SUMMON_DATA_DIR均相同，无链接。不能据命令工具旧读数宣称配置丢失。旧轮通过原生Explorer复制当前**加密**配置到忽略dist临时目录读取；Key仅内存解密，不保存/打印；副本测后删除。如果必须重查，注意这一现象，不要求用户贴Key。原生文件复制时type_text用剪贴板会冲掉文件复制，需先备好目标，回源复制，用Alt+Right回目标粘贴。

已安装目录 `D:/Tools/Reed`；官方配置root `https://api.deepseek.com`，真实modelId `deepseek-flash`，另一个 `deepseek-v4-pro`，compat.thinkingFormat=`deepseek`。界面显示名不是wire modelId。

## 8. 既有产物和Release边界

旧最终构建源：`9bca08d9828cba73defbfb0d3f36db2bbc01a9d3`，产物 `dist/Reed-0.2.2-model-final`。

- 旧安装包SHA256：`625d5a1dc7c47faff5841e8faf526cfe06d9d645dbc0e9f573434f4e69f970f1`。
- 旧便携ZIP SHA256：`30b67b9846b97cd1439aca5a03665f837075eb320a673552900b64a564f4af21`。
- 既有 GitHub Release Draft ID `412479090`，上轮target `092388c`，三个附件uploaded/digest一致，仍draft。历史链接：`https://github.com/RynOrca/Reed/releases/tag/untagged-079b5d98e705ea0280c7`，draft untagged链接可能变化，按ID核对。
- 本轮尚未远端刷新，以上是旧轮交接信息，不是本轮最新API验证。
- 没有更新签名私钥；不生成虚假签名更新，不改公钥绕过，不安装替换用户Reed。

## 9. 接手的最低完成标准

- 停止各阶段可达、终态幂等、busy清除；下一条可用，旧任务不污染，服务资源状态有证据。
- 合成大库冷/暖耗时、最大事件循环lag、取消耗时有前后同环境测量，不拿平均值掩盖长阻塞。
- 总览分批/压缩/汇总失败可恢复，旧总览不覆盖，模型/档位/凭据/目录隔离正确；明确真实官方medium是否获授权且实际测过。
- 三/二/一列、五行、正文去YAML、五篇分页在新构建原生窗口验证。
- 全部改完统一测试构建；报告清楚通过/失败/环境阻断/未验证，源码和交付包版本一致。
- 按已确认范围仅更新0.2.2及原Draft，保持main和用户安装不变。

## 保全记录

WIP 保全提交：`c8e35a7553991c90b6546caba5269581c14147b2`（`wip: preserve unverified cancellation and vault fixes for DeepSeek handoff`），**不是修复完成提交**；最终交接记录提交在Git日志和CHANGELOG可查。接手可基于原基线审查 diff，避免丢失本轮未验收代码。没有运行中的本轮测试等待继续；性能基线和定向测试均已退出。全量、构建、原生、真实模型验证仍 pending；外部发布/运行态核对 out-of-scope；平台记忆未修改。
