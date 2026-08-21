# OpenFicM 项目交接记录

最后更新：2026-08-21

这份文档用于让新的开发窗口快速恢复项目上下文。继续工作前先阅读本文件、根目录 AGENTS.md、README.md 和 mobile-rn/DESIGN.md。

## 1. 项目定位

OpenFicM 是 OpenFic 的 React Native Android 独立移动端重构，不是把桌面端网页套进 WebView。目标是让用户在 Android 手机上本地管理小说、章节、角色、世界书和 Agent 对话；应用不需要电脑配合运行，也不需要 FastAPI、Socket.IO 或 Metro。

应用不是完全断网产品：作品数据和本地 Agent 运行时在手机上，用户仍可配置任意供应商的模型 API、获取供应商模型列表，并在首次启动时从 GitHub/Hugging Face 获取 Agent、Skill、嵌入和重排资源。API Base URL、Key、模型和供应商均由用户配置。

当前正式版本：0.7.7

GitHub 仓库：

- 源码：https://github.com/tioners/OpenFicM
- 正式 Release：https://github.com/tioners/OpenFicM/releases/tag/v0.7.7
- 上游 OpenFic：https://github.com/syrizelink/OpenFic
- Skill/Agent 内容来源：https://github.com/worldwonderer/oh-story-claudecode

仓库是从上游 OpenFic clone 出来的，本地继承了上游全部 Git 标签（v0.2.0 到 v0.10.0）。这些标签指向 syrizelink 的提交，不是 OpenFicM 的发布点。打新版本标签前必须先确认同名标签是否已被上游占用，否则会像 v0.7.3 那样把 Release 挂到上游代码上。v0.7.3 的 Release 页面因此指向上游提交 7ea4437，APK 资产本身是正确的；该版本已由 0.7.4 取代，不再修复。

## 2. 当前交付状态

- Git 分支：main
- 最新源码提交：本次 0.7.7 发布提交，以 v0.7.7 标签为准
- 本轮审查基线：8f884b6 fix(llm): surface output truncation instead of reporting empty content
- Release 标签：v0.7.7
- Android applicationId：com.openfic.mobile
- versionCode：14
- versionName：0.7.7
- 最低 Android：9.0，minSdk 28
- ABI：仅 arm64-v8a
- Release APK：仓库根目录 OpenFicM-Android-0.7.7.apk；APK 和密钥均被 Git 忽略
- 正式签名证书 SHA-256：c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863

0.7.7 继续使用 0.7.0 的正式证书，因此可以直接覆盖升级。本版修复用户实测发现的三个问题：文风蒸馏汇总步骤被输出截断误报成"内容为空"、换模型后重试仍打旧模型、文风指南预览滚不动；并新增蒸馏模型显示、模型列表搜索和应用更新检查。0.7.7 把所有底部弹层的遮罩收敛到 `SheetBackdrop`，修掉 responder 抢占导致的滚动时灵时不灵，详见 docs/releases/v0.7.7.md。0.7.6 的截断误判修复见 docs/releases/v0.7.6.md，0.7.5 的多轮继续蒸馏见 docs/releases/v0.7.5.md。

## 3. 功能清单

### 书架和写作

- 本地书架：新建、删除和打开作品。
- 卷管理：新建、重命名、删除；至少保留一卷。
- 章节管理：按卷分组，新建、重命名、删除和切换章节。
- 写作页默认预览模式，点击编辑后才进入正文输入框。
- 自动保存、后台保存、手动保存并返回预览。
- 输入法使用 resize 和焦点滚动，避免底部编辑区域被遮挡。
- 导出当前章节、当前卷或整本小说为 Markdown；导出前先保存草稿，然后从 SQLite 重新读取最新数据，通过 Android 系统分享面板交给用户保存或分享。

### 助手和 Agent

- 助手数据按作品隔离；切换书架作品后只显示该作品的会话和聊天记录。
- 支持新建、切换、删除会话，记录会话标题、模型和消息 Agent trace。
- 助手顶部显示当前作品、当前主智能体和当前模型，可切换模型。
- API 或 Agent 运行失败后保留原用户消息，支持重试；重试删除失败提示并复用原用户消息，不重复插入用户消息。
- 可以编辑历史用户消息；编辑点及其后续消息在 SQLite 独占事务中删除，再以新内容重新运行 Agent，保持线性上下文。
- Agent 具有工具权限、结构化提问、实时 trace、角色/世界书/章节工具和子智能体委派能力，不是只返回文本的聊天窗口。
- 基础 Agent/Skill 不再静态打进 APK；首次启动从 OpenFicM GitHub catalog 拉取并校验，oh-story 和 Lorn 内容也通过运行资源门禁按需安装，不执行远程脚本或 Hook。
- 章节变化后会触发角色和世界书的一致性检查，Agent 可根据创作内容变动更新设定资料；检查是提示词层的建议而不是运行时硬阻塞，未发现变化时不会追加额外模型请求。
- 是否委派子智能体由模型按任务判断，运行时不再强制。主智能体与其全部子智能体共享一次对话最多 24 次模型请求的预算，超出后明确报错而不是继续放大限流。

### 设置和模型

移动端已导入桌面端主要设置分类：

- 通用
- 索引
- 上下文
- 工具权限
- 规则
- 技能
- 智能体
- 高级

供应商支持 OpenAI-compatible、Google Gemini 和 Anthropic 风格请求。供应商配置包含 Base URL、API Key、模型名，并支持从供应商 API 获取模型列表。API Key 使用 expo-secure-store，SQLite 不保存明文 Key。

### 文风系统

- 独立文风书库支持 TXT、Markdown 和 EPUB，兼容 UTF-8、UTF-16、GB18030/GBK；原文件和规范化正文保存在应用私有目录。
- 参考文风蒸馏按连续窗口分轮进行：每轮读取连续 24 章（无章节标题的书按每约 1,400 字符切段），分 4 批分析加 1 次合并，共 5 次模型请求；完整参考书不上传。
- "继续蒸馏"每次向后随机跳到未读区域再取一个窗口，单向递增不重叠，跳幅受"剩余的一半"和"4 个窗口"双上界约束，必然收敛到书尾；覆盖进度存在 `style.distillation.coverage.<sourceId>`。
- 多轮证据用增量演进合成：以上一版指南为基线并入本轮新证据，不全量重发历史备忘录，因此轮数不受上下文长度限制。
- 断点记录所属窗口，中断续跑会重放同一段正文，不会复用旧备忘录去分析新窗口。
- 参考文风与作品无关，可跨作品选择；作者文风按作品隔离，并保存递增版本。
- 助手页和写作页都可选择创作文风；文风会注入主智能体和正文类子智能体。
- `write_chapter`/`edit_chapter` 保存 AI 原稿和所用文风；作者实际修改并保存后，可在预览页进化当前作品的作者文风。
- 完整用户操作和隐私说明见 `docs/USER_GUIDE.md`，0.7.7 发布亮点见 `docs/releases/v0.7.7.md`。

### 本地检索

- APK 不包含中文嵌入 GGUF 和重排 GGUF。首次启动从 Hugging Face 拉取到应用私有目录，临时文件完成大小和 SHA-256 校验后才安装。
- 运行资源完整后自动预热两个模型；高级设置不再提供手动预热/释放按钮，只显示状态和一键修复入口。
- llama.rn 在手机 CPU 上加载模型；本机没有 Hexagon SDK，所以当前构建日志显示 CPU-only，这是预期降级，不是构建失败。
- APK 仍包含 React Native、llama.rn 和应用所需的 arm64 原生库；运行资源层面不应出现 `.gguf`、OpenFicM/Lorn catalog 或 Agent/Skill 静态目录。

## 4. 代码结构

工作目录：C:\Users\hujiawei\OpenFic

### mobile-rn

- src/screens/projects-screen.tsx：书架和作品入口。
- src/screens/writing-screen.tsx：卷章目录、预览/编辑、保存和 Markdown 导出入口。
- src/screens/assistant-screen.tsx：作品级助手会话、模型选择、消息编辑和重试。
- src/screens/style-library-screen.tsx：参考书导入、文风蒸馏、参考/作者文风版本和作品级选择。
- src/screens/settings-screen.tsx、settings-category-screen.tsx：设置分类和设置项。
- src/agent/runtime.ts：Agent 主循环、工具调用、结构化提问、子 Agent 协作和 trace。
- src/agent/tools.ts：移动端本地工具定义和执行边界。
- src/llm/client.ts：供应商请求、响应归一化、输出截断检测和 Gemini schema 兼容处理。`callModel` 支持 `minOutputTokens` 选项，供结构上必须长输出的步骤抬高预算下限。
- src/settings/app-update.ts：查询本项目 GitHub 最新 Release 并与 app.json 的版本比较。`compareVersions` 按段做数值比较，不依赖 expo-constants。
- src/data/database.ts：Expo SQLite 初始化、迁移和事务。
- src/data/repositories.ts：作品、卷、章节、角色、世界书、会话、消息、模型和设置仓储。
- src/data/style-repositories.ts、chapter-draft-repositories.ts：参考书/文风版本和 AI 原稿快照仓储。
- src/lib/export.ts：Markdown 导出；文件名清理、范围筛选、缓存文件和系统分享。
- src/search：本地全文、嵌入和重排索引。
- src/settings：默认设置、运行时 Agent/Skill 资源安装、Lorn 文风插件和 oh-story 内容更新。
- src/style/source-library.ts：TXT/Markdown/EPUB 安全导入、编码识别、正文规范化，以及章节/段落单元切分与窗口取样。
- src/style/sampling.ts：纯抽样逻辑（`nextSampleWindow`、`spreadIndices`）。不依赖 expo 或数据库，可用 `npx tsc --ignoreConfig` 单独转译后在 Node 里推演窗口走向。
- src/components/ui.tsx：通用 UI 控件。底部弹层一律用 `SheetBackdrop` 包裹，不要退回"Pressable 包住整个弹层 + 内容加 onStartShouldSetResponder"的写法，那会抢走 JS responder 并挡住内部 ScrollView。
- src/components：移动端通用 UI、错误提示、Agent trace 和输入控件。
- assets/models：运行时模型来源、许可证和哈希说明；大 GGUF 不应被 Git 追踪。
- android/app/build.gradle：Android 版本、签名环境变量和 Release 配置。
- scripts/build-release.ps1：清理旧 app 构建输出、拒绝内置 GGUF、执行正式签名、版本命名、可选 lineage 签名和 SHA-256 输出。

### 保留的上游目录

backend、frontend、desktop 是保留的 OpenFic 上游源码和兼容修复，移动端运行不依赖这些目录。除非用户明确要求修复桌面端，否则不要把移动端功能改动扩散到上游目录。

## 5. 关键设计决策

1. 本地优先：作品、章节、角色、世界书、索引和对话默认存手机；只有用户发起模型请求时才把必要上下文发给外部供应商。
2. 作品级会话：chat_sessions.project_id 是聊天隔离边界；助手不能因为切换作品而看到另一部书的历史。
3. 线性消息编辑：编辑历史消息会删除该条及后续消息，这是为了避免保留不再成立的 Agent 分支上下文。
4. 可恢复 Agent：失败消息作为 assistant 侧的任务未完成记录保存，RetryRequest 在界面内保存原消息和历史快照；重试不产生重复 user 行。
5. 预览优先：手机触屏容易误触，章节进入时先读预览，点击编辑后才显示输入控件。
6. 系统分享导出：导出文件写入 Expo cache，不申请外部存储权限，由 Android 分享/文件管理器决定最终保存位置。
7. Gemini schema：function declaration 的每个参数必须有 type；React Native 侧递归补齐缺失类型并清理不支持的 additionalProperties，修复 chapter_ref 导致的 400；工具回合还必须原样带回 Gemini thoughtSignature。
10. 输出截断不做静默降级：思考型模型的推理 Token 也计入 max_tokens，正文可能一个字都没返回。三个供应商分支都检查截断状态并抛出可操作的报错，不再让调用方只看到"内容为空"。
11. 重试以当前选中的模型为准：失败消息里记录的 modelId 只作兜底，否则用户换了可用模型后仍会打回出错的旧模型。
12. 应用版本读自 app.json，不引入 expo-constants 运行时依赖；该文件就是构建 APK 时使用的同一份配置。
8. 供应链限制：OpenFicM 基础 catalog 与 Lorn 移动目录绑定不可变提交 1a848fbe77f9952c38aac8c18240026154446114 并校验 SHA-256；oh-story 只按白名单读取 Markdown 并绑定 Release commit/tree/blob SHA，远程 Hook、脚本和 Git 配置不会执行。
9. 文风边界：参考书是全局本地资料，参考文风可跨作品，作者文风只属于单部作品；蒸馏只向用户供应商发送有界样本，完整原文件不上传。

## 6. 构建与验证

### 普通开发检查

在 mobile-rn 目录执行：

~~~powershell
npm ci
npm run type-check
~~~

当前 type-check 已通过。项目没有为本轮移动端功能新增自动化 UI 测试；继续开发时优先补仓储事务和导出纯函数测试，不要把测试写进没有既有测试基础的页面快照体系。

### 正式构建

正式签名文件不在仓库：

- C:\Users\hujiawei\.android\OpenFicM-release.p12
- C:\Users\hujiawei\.android\OpenFicM-release-credential.xml

credential.xml 是当前 Windows 用户可解密的本地凭据序列化文件。不要读取其密码并打印，也不要提交 p12、credential.xml、debug.keystore 或 APK。

安全构建方式：

~~~powershell
cd C:\Users\hujiawei\OpenFic\mobile-rn
$credential = Import-Clixml "$HOME\.android\OpenFicM-release-credential.xml"
$password = $credential.GetNetworkCredential().Password
$env:NODE_ENV = "production"
$env:OPENFICM_RELEASE_STORE_FILE = "$HOME\.android\OpenFicM-release.p12"
$env:OPENFICM_RELEASE_STORE_PASSWORD = $password
$env:OPENFICM_RELEASE_KEY_ALIAS = $credential.UserName
$env:OPENFICM_RELEASE_KEY_PASSWORD = $password
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
~~~

脚本会先删除仓库内受路径校验保护的 android/app/build 生成目录，避免增量构建复用旧资源；生成 APK 后还会拒绝任何 .gguf 条目。成功时在仓库根目录生成 OpenFicM-Android-0.7.7.apk 并打印 SHA-256。没有四个 OPENFICM_RELEASE_* 变量时，app/build.gradle 会拒绝 assembleRelease；这是防止误用调试证书发布的有意保护。没有正式密钥时只运行 npm run android:apk:debug，并明确标为本地测试包。

### 已完成的校验

- npm run type-check：通过。
- 抽样算法验证：把 `src/style/sampling.ts` 用 `npx tsc --ignoreConfig` 转译后在 Node 里跑了 1000 次随机全流程，确认窗口无重叠、无回退、必然收敛到书尾；1200 章的书走向为第 1-24、100-123、180-203、293-316 章……共约 17 轮。
- Gradle assembleRelease：BUILD SUCCESSFUL。
- Release 脚本正式签名：成功。脚本末尾的 Get-FileHash 在从 Git Bash 嵌套调用 PowerShell 时会因 PSModulePath 丢失而报 CommandNotFoundException；APK 本身已生成并签名，改用 sha256sum 或在原生 PowerShell 会话中重跑即可。
- apksigner verify --verbose：Verifies，v2 签名方案通过，正式证书为 c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863。
- aapt2：package com.openfic.mobile，versionCode 12，versionName 0.7.5，minSdk 28，targetSdk 36。
- APK ZIP：1220 个条目，内置 index.android.bundle，仅 arm64-v8a；不含 GGUF、OpenFicM/Lorn catalog 或 Agent/Skill 目录。
- APK 大小：132,501,360 字节（126.36 MiB）。
- APK SHA-256：60A2FF78E7B106AFFA7EA2E6E331A1BC105569FFD4DC876BF0E9BE79C10DAD6B。
- 真机验证（红米 25102RKBEC，从 0.7.5 覆盖升级）：安装成功、数据保留、启动无 FATAL。
- 真机验证（0.7.6 新功能）：高级设置的应用版本检查跑通，查到远端 v0.7.5、本机 0.7.6，正确显示"已是最新"而不是误报可更新；模型列表"查找模型"过滤正常（输入 grok 从 5 个筛到 2 个，计数显示 2/5）；参考书详情页正确显示当前默认模型名。
- 真机验证（蒸馏链路）：用《斗破苍穹》（540 万字）跑通 4/4 批次分析，断点带窗口正确续跑未重头开始，批次标签显示真实章号。汇总步骤仍未跑通，但失败模式已从误报的"模型返回的文风指南不能为空"变成 HTTP 层的准确报错，说明截断误判确实被修掉了。
- 未完成的真机验证：一次完整成功的蒸馏（含汇总落库和"继续蒸馏"轮次推进）。两套中转都在汇总这一步失败：公益中转 429 限流，openrouter 的 stealth/ox-alpha 返回 HTTP 200 + 非 JSON 响应体。都是服务端行为，不是应用缺陷；0.7.6 新增的响应体片段回显可以在下次复现时直接看到中转返回了什么。
- npm audit：报告 Metro 构建链的 image-size 高危 DoS 和 Xcode 构建链的 uuid 中危问题；它们不进入 APK，且 image-size 截至 2026-08-20 无上游修复版本。不要运行会把 Expo 57 降到 53 的 npm audit fix --force，等待 Expo/Metro 上游升级。

本轮未重跑 expo-doctor 与 0.7.1 时的 catalog 下载校验、verify-change/quality/security 检查；改动只涉及文风抽样、蒸馏流程、文风书库界面和文档，未触及供应链常量或原生依赖。

## 7. 发布流程

源码推送：

~~~powershell
$env:http_proxy = "http://127.0.0.1:10808"
$env:https_proxy = "http://127.0.0.1:10808"
git push origin main
~~~

正式 Release 使用 GitHub CLI：

~~~powershell
gh release create v0.7.7 .\OpenFicM-Android-0.7.7.apk --repo tioners/OpenFicM --target main --title "OpenFicM 0.7.7" --notes-file docs/releases/v0.7.7.md --latest
~~~

不要把 APK 或签名文件加入 Git。发布前先用 apksigner、aapt2、Get-FileHash 检查资产；发布后用 gh release view v0.7.7 和 gh release list 验证标签及资产。

## 8. 已知限制和后续重点

- 0.7.5 的一整轮蒸馏尚未在真机上跑通，卡在用户的公益中转站限流。已定位为请求体量问题而非中转站故障：同一中转、同一模型、同一时刻，助手的小请求成功返回，而蒸馏的第一个批次请求立刻收到 `{"code":429,"type":"upstream_error"}`。
- 蒸馏单次请求约 20,600 字符：system 侧的 Lorn 方法论占 12,000（`STYLE_MODEL_INSTRUCTION_CHARACTERS`），user 侧样本占 8,400（`ANALYSIS_BATCH_SIZE` 6 × `ANALYSIS_PASSAGE_CHARACTERS` 1,400）。中文约合 15K-20K tokens，是普通聊天请求的 5-7 倍，容易触发按 TPM 计费的中转站限流。
- 方法论正文在一轮 4 个批次里被重复发送 4 次，累计约 48,000 字符。若要降低单请求体量，可调 `STYLE_MODEL_INSTRUCTION_CHARACTERS` 或 `ANALYSIS_BATCH_SIZE`，但两者分别影响方法论保真度和每轮请求次数，属于需要用户拍板的取舍，本轮未擅自修改。
- 0.7.4 的 APK 仅在助手侧做过真机验证，复杂创作任务是否仍触发 429、一致性检查状态是否如实显示，仍需在真我 GT7 和红米 K90 PRO MAX 上实测，同时观察长期创作、升级、分享导出和本地模型内存表现。
- 24 次模型请求预算是按主智能体 12 轮加一层子智能体 12 轮估算的上限。如果实测中正常任务频繁撞上限，应先确认是不是模型陷入了工具调用循环，再考虑调整 MAX_TOTAL_MODEL_REQUESTS，不要直接放大预算。
- CPU-only 是当前环境的构建结果；旗舰手机性能足够，但首次加载 GGUF 仍可能需要时间和较多内存。
- API 不可达时现在支持重试，但没有离线替代的云模型回答；本地作品编辑和本地检索仍可用。
- Release 只提供 arm64-v8a；不应为了兼容旧 32 位设备引入额外 ABI，除非重新评估两个 GGUF 带来的体积。
- 远程 oh-story 更新必须由用户主动操作；不要自动执行远程 Hook，也不要把远程 Markdown 当作可执行代码。
- Android 系统分享能力由设备 ROM 决定；导出文件写入 cache，用户应在分享面板选择文件管理器或目标应用。
- 继续修改 Agent 时必须确认工具权限、询问流程、trace、失败恢复和角色/世界书一致性都仍然有效，不能只增加 UI 假控件。

## 9. 新窗口接手步骤

1. 读取本文件、AGENTS.md、README.md、mobile-rn/DESIGN.md 和最近的 git log。
2. 执行 git status --short --branch，确认远程是否有新提交；不要 reset --hard 或覆盖用户未提交改动。
3. 从 mobile-rn/src/screens 找到 UI 入口，再沿 repositories、agent/runtime、agent/tools 和 llm/client 追踪调用链。
4. 修改前先搜索现有仓储和组件，优先复用，不要在 screen 内复制 SQLite 或模型请求逻辑。
5. 修改后至少执行 npm run type-check、git diff --check；涉及发布时再执行正式构建和 APK 校验。
6. 发布前确认 git status 干净、APK/密钥被忽略、版本号和 CHANGELOG/README/DESIGN 一致。

## 10. 不要做的事

- 不要恢复 Socket.IO、FastAPI 或电脑后端依赖；移动端定位是本地运行。
- 不要硬编码任何 API Key、签名密码、GitHub Token 或代理凭据。
- 不要把 debug.keystore 当正式包签名，也不要把私钥放进仓库或 Release 资产。
- 不要为了处理单个 UI 问题重写数据库、Agent runtime 或整个导航架构。
- 不要删除用户已有的未提交改动或本地数据；删除卷章、聊天记录和导出文件都要有明确用户动作。
