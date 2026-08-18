# 移动端设计说明

## 架构

- `screens` 负责移动端交互和生命周期处理。
- `data` 使用 Expo SQLite 保存作品、卷、章节、消息和模型配置。
- `expo-secure-store` 保存供应商 API Key，SQLite 只保存 SecureStore 引用。
- `llm/client.ts` 将 OpenAI-compatible、Gemini 和 Anthropic 的请求/响应格式归一为 Agent turn。
- `agent` 只调用本地仓储工具，不依赖桌面端后端。
- `search` 使用内置 GGUF 嵌入和重排模型，为章节、角色和世界书建立本地向量索引。
- `settings` 保存索引、上下文、工具权限、规则、技能和智能体配置。

## 网络边界

应用本身没有本地 HTTP 服务，也没有 Socket.IO 连接。网络请求只由模型客户端发往用户配置的 Base URL。Base URL 和 API Key 都在调用前经过校验；模型响应按 HTTP 状态和 JSON 格式处理，并设置 120 秒超时。

oh-story 内容更新是第二个显式网络入口，只连接 GitHub REST API 与 Raw CDN。应用先读取最新正式 Release，再记录对应的不可变 Git commit/tree SHA；安装仅下载 13 个白名单 Markdown，并限制单文件和整包大小。远程仓库中的脚本、Hook、Git 配置、浏览器自动化与其他文件均不会下载或执行。

## 本地检索

- bge-small-zh-v1.5-q4_k_m.gguf 负责生成中文查询和资料向量。
- bge-reranker-base-q4_k_m.gguf 对召回候选进行本地重排。
- 两个模型均通过 llama.rn 在 CPU 上运行，按需加载并可在高级设置中释放。
- SQLite 只保存向量分块和来源元数据，索引可单独清除或重建。

## Android 适配

- 仅构建 arm64-v8a，减少包含两个本地模型后的 APK 体积。
- GGUF 资源使用 noCompress 打包，避免安装包内二次压缩和大文件解压开销。
- softwareKeyboardLayoutMode=resize、Manifest adjustResize 与 react-native-keyboard-controller 共同处理厂商输入法。
- 长表单使用焦点感知滚动容器；写作和助手页面按键盘高度缩短，底部编辑区域不会被遮挡。
- Android 原生目录随项目交付并直接构建；修改 app.json、Expo 插件或原生依赖后必须重新运行 prebuild，并复核本地 SDK 路径、Gradle 镜像脚本、ABI、权限和 GGUF noCompress 配置。

## 写作与导出

- 章节默认以预览模式打开，显式点击编辑后才显示输入框；保存成功后返回预览，减少触屏误改。
- 导出前先持久化当前草稿，再从 SQLite 读取最新卷章数据，支持当前章节、当前卷和整本小说三种范围。
- 导出内容在应用缓存目录生成 Markdown，文件名剔除 Android/Windows 非法字符，然后交给系统分享面板；应用不自行申请外部存储权限。

## 助手消息分支

- API 调用失败时保留原用户消息和当次历史快照；重试只删除失败提示并重新运行 Agent，不重复插入用户消息。
- 编辑历史用户消息会在 SQLite 独占事务中删除该条及其后续消息，再保存修改内容并重新运行 Agent，确保线性对话上下文与界面一致。
- 对话切换会清除仅属于当前界面的编辑和重试状态，避免跨作品或跨会话误操作。

## Gemini Schema

Gemini function declaration 使用大写 Schema 类型，并移除不受支持的 `additionalProperties`。React Native 客户端递归补齐缺失类型；桌面端在绑定 Google 工具前展开本地 `$defs` 引用，并将可空 `anyOf` 折叠为带 `nullable` 的单一类型，避免 `chapter_ref` 缺少 `type` 导致 400。

## 数据安全

- API Key 不进入 SQLite、聊天消息或调试日志。
- SQL 使用参数绑定；章节内容在保存边界限制为最多 2,000 行或 100,000 字符。
- 用户可配置 HTTP API，因此 Android 允许明文流量；生产供应商建议使用 HTTPS。

## oh-story 供应链边界

- 威胁模型：Release 标签可被移动、远程 Markdown 可包含越权指令、下载内容可能异常膨胀、安装中断可能造成版本状态不一致。
- 安全决策：检查结果绑定 Git commit/tree SHA，文件通过不可变 commit 路径获取并核对 tree 白名单；同版本 commit 变化拒绝覆盖；单文件、整包、文件路径和文件数量均采用本地白名单与上限。
- 执行边界：远程内容只作为模型指令数据；运行时工具集合由本地代码生成，子智能体不能自行增加工具，写工具继续遵循允许/询问/禁止权限。
- 状态一致性：当前包与回滚包在 SQLite 独占事务中一起切换，SHA-256 用于本地安装记录和问题追踪。
- 已知风险：应用信任 GitHub HTTPS 返回的数据和上游仓库维护者发布的 Markdown 语义；因此更新必须由用户手动确认，不做后台静默安装。
- 上游构建工具风险：npm Audit 当前标记 Metro 使用的 `image-size@1.2.1` 和 iOS 工程生成链的 `uuid@7.0.3`；两者不进入 Android 运行时数据路径，且自动修复会把 Expo 57 错误降级到 53，因此本版本不强制覆盖，等待 Expo SDK 上游升级。

## 变更记录

### 2026-08-17 - React Native Android 核心移植

新增本地 SQLite 写作数据层、模型供应商适配、离线可启动的移动 UI 和 Gemini schema 兼容处理。

### 2026-08-17 - 移动端完整设置与本地检索

新增角色、世界书、供应商模型发现、桌面端对应设置分类、本地嵌入与重排模型，并完善 Android 键盘避让和 arm64 打包配置。

### 2026-08-17 - 作品级会话、协作智能体与 oh-story 更新

新增作品隔离的聊天会话、PC 内置技能/智能体、子智能体委派、章节变动后的角色与世界书双重一致性检查，以及绑定 Git tree/blob SHA、可事务回滚的 oh-story Markdown 内容更新。

### 2026-08-17 - OpenFicM 0.4.0 卷章管理与开源发布

写作页目录按卷分组，增加卷与章节的新建、重命名和删除；删除事务同步清理 FTS、向量索引并触发设定一致性检查。正式签名密钥移出仓库，GGUF 改为校验下载，公开 CI 只验证移动端依赖与类型。

### 2026-08-18 - OpenFicM 0.5.0 稳定性与发布校验

角色与世界书删除事务同步清理向量索引；助手离开作品或页面时取消未完成的结构化提问；设置页持久化失败时保留可见错误并避免未处理 Promise。正式构建脚本要求 lineage 同时提供旧、新签名者。

### 2026-08-19 - OpenFicM 0.6.0 导出与可恢复编辑

写作页改为预览优先并支持章节、卷、全书 Markdown 导出；助手增加失败请求重试和历史用户消息编辑，编辑点之后的线性上下文通过事务统一重建。
