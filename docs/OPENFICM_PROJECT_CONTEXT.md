# OpenFicM 项目交接记录

最后更新：2026-08-19

这份文档用于让新的开发窗口快速恢复项目上下文。继续工作前先阅读本文件、根目录 AGENTS.md、README.md 和 mobile-rn/DESIGN.md。

## 1. 项目定位

OpenFicM 是 OpenFic 的 React Native Android 独立移动端重构，不是把桌面端网页套进 WebView。目标是让用户在 Android 手机上本地管理小说、章节、角色、世界书和 Agent 对话；应用不需要电脑配合运行，也不需要 FastAPI、Socket.IO 或 Metro。

应用不是完全断网产品：作品数据和本地 Agent 运行时在手机上，用户仍可配置任意供应商的模型 API、获取供应商模型列表，并可选检查 oh-story-claudecode 内容更新。API Base URL、Key、模型和供应商均由用户配置。

当前正式版本：0.6.0

GitHub 仓库：

- 源码：https://github.com/tioners/OpenFicM
- 正式 Release：https://github.com/tioners/OpenFicM/releases/tag/v0.6.0
- 上游 OpenFic：https://github.com/syrizelink/OpenFic
- Skill/Agent 内容来源：https://github.com/worldwonderer/oh-story-claudecode

## 2. 当前交付状态

- Git 分支：main
- 最新源码提交：992b082 docs: add OpenFicM project handoff context
- 最近功能提交：5fbf10d feat(mobile): add export and recoverable editing
- Release 标签：v0.6.0
- Android applicationId：com.openfic.mobile
- versionCode：6
- versionName：0.6.0
- 最低 Android：9.0，minSdk 28
- ABI：仅 arm64-v8a
- Release APK：仓库根目录 OpenFicM-Android-0.6.0.apk；APK 和密钥均被 Git 忽略
- APK SHA-256：E74E53F2D13D8974E21520C580D9BBBAE482D055143ED1DFA0032E107E29D3A8
- 正式签名证书 SHA-256：c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863

0.6.0 的正式证书与 0.5.0 相同，因此可以直接覆盖升级。此前为了验证构建曾生成过 debug 签名的本地测试 APK，但它不是交付包，也不应上传为正式 Release。

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
- 内置 PC 端技能和智能体已同步到移动端；oh-story 更新只下载白名单 Markdown，不执行远程脚本或 Hook。
- 章节变化后会触发角色和世界书的一致性检查，Agent 可根据创作内容变动更新设定资料。

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

### 本地检索

- APK 内置中文嵌入 GGUF 和重排 GGUF。
- 资源通过 Android noCompress 打包，不在安装包内二次压缩。
- llama.rn 在手机 CPU 上加载模型；本机没有 Hexagon SDK，所以当前构建日志显示 CPU-only，这是预期降级，不是构建失败。
- APK 中已验证包含：4,440,532 字节的 index.android.bundle、219,068,480 字节的 GGUF、15,448,256 字节的 GGUF。

## 4. 代码结构

工作目录：C:\Users\hujiawei\OpenFic

### mobile-rn

- src/screens/projects-screen.tsx：书架和作品入口。
- src/screens/writing-screen.tsx：卷章目录、预览/编辑、保存和 Markdown 导出入口。
- src/screens/assistant-screen.tsx：作品级助手会话、模型选择、消息编辑和重试。
- src/screens/settings-screen.tsx、settings-category-screen.tsx：设置分类和设置项。
- src/agent/runtime.ts：Agent 主循环、工具调用、结构化提问、子 Agent 协作和 trace。
- src/agent/tools.ts：移动端本地工具定义和执行边界。
- src/llm/client.ts：供应商请求、响应归一化和 Gemini schema 兼容处理。
- src/data/database.ts：Expo SQLite 初始化、迁移和事务。
- src/data/repositories.ts：作品、卷、章节、角色、世界书、会话、消息、模型和设置仓储。
- src/lib/export.ts：Markdown 导出；文件名清理、范围筛选、缓存文件和系统分享。
- src/search：本地全文、嵌入和重排索引。
- src/settings：默认设置、PC 内置技能/智能体同步和 oh-story 内容更新。
- src/components：移动端通用 UI、错误提示、Agent trace 和输入控件。
- assets/models：模型下载/校验相关脚本与资源配置；大 GGUF 不应被 Git 追踪。
- android/app/build.gradle：Android 版本、签名环境变量、GGUF noCompress 和 Release 配置。
- scripts/build-release.ps1：正式 Release 构建、版本命名、可选 lineage 签名和 SHA-256 输出。

### 保留的上游目录

backend、frontend、desktop 是保留的 OpenFic 上游源码和兼容修复，移动端运行不依赖这些目录。除非用户明确要求修复桌面端，否则不要把移动端功能改动扩散到上游目录。

## 5. 关键设计决策

1. 本地优先：作品、章节、角色、世界书、索引和对话默认存手机；只有用户发起模型请求时才把必要上下文发给外部供应商。
2. 作品级会话：chat_sessions.project_id 是聊天隔离边界；助手不能因为切换作品而看到另一部书的历史。
3. 线性消息编辑：编辑历史消息会删除该条及后续消息，这是为了避免保留不再成立的 Agent 分支上下文。
4. 可恢复 Agent：失败消息作为 assistant 侧的任务未完成记录保存，RetryRequest 在界面内保存原消息和历史快照；重试不产生重复 user 行。
5. 预览优先：手机触屏容易误触，章节进入时先读预览，点击编辑后才显示输入控件。
6. 系统分享导出：导出文件写入 Expo cache，不申请外部存储权限，由 Android 分享/文件管理器决定最终保存位置。
7. Gemini schema：function declaration 的每个参数必须有 type；React Native 侧递归补齐缺失类型并清理不支持的 additionalProperties，修复 chapter_ref 导致的 400。
8. 供应链限制：oh-story 远程更新只按白名单读取 Markdown，绑定 Release commit/tree/blob SHA，远程 Hook、脚本和 Git 配置不会执行。

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

脚本会在仓库根目录生成 OpenFicM-Android-0.6.0.apk，并打印 SHA-256。没有四个 OPENFICM_RELEASE_* 变量时，app/build.gradle 会拒绝 assembleRelease；这是防止误用调试证书发布的有意保护。没有正式密钥时只运行 npm run android:apk:debug，并明确标为本地测试包。

### 已完成的校验

- npm run type-check：通过。
- Gradle assembleRelease：BUILD SUCCESSFUL。
- Release 脚本正式签名：成功。
- apksigner：v2 签名验证通过，正式证书为 c5dd…f863。
- aapt2：package com.openfic.mobile，versionCode 6，versionName 0.6.0。
- APK 条目：JS bundle 和两个 GGUF 均存在且大小非零。
- verify-change：通过，设计文档已同步。
- verify-quality：通过；仅报告已有 runtime.ts 和 repositories.ts 文件超过 500 行以及若干既有长行。
- verify-security：严重、高危、中危、低危均为 0。

## 7. 发布流程

源码推送：

~~~powershell
$env:http_proxy = "http://127.0.0.1:10808"
$env:https_proxy = "http://127.0.0.1:10808"
git push origin main
~~~

正式 Release 使用 GitHub CLI：

~~~powershell
gh release create v0.6.0 .\OpenFicM-Android-0.6.0.apk --repo tioners/OpenFicM --target main --title "OpenFicM 0.6.0" --notes-file notes.md --latest
~~~

不要把 notes.md、APK 或签名文件加入 Git。发布前先用 apksigner、aapt2、Get-FileHash 检查资产；发布后用 gh release view v0.6.0 和 gh release list 验证标签及资产。

## 8. 已知限制和后续重点

- 当前没有在真我 GT7 或红米 K90 PRO MAX 上由开发环境实机回归；用户需要手动测试正式 APK 的安装、升级、分享导出、输入法、Agent 工具权限和本地模型加载。
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
