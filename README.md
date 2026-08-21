<div align="center">

# OpenFicM

**在手机上完成小说创作的本地优先 Android 应用**

[![Release](https://img.shields.io/github/v/release/tioners/OpenFicM?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC&color=2e7d5b)](https://github.com/tioners/OpenFicM/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/tioners/OpenFicM/total?label=%E4%B8%8B%E8%BD%BD%E9%87%8F&color=2e7d5b)](https://github.com/tioners/OpenFicM/releases)
[![Android](https://img.shields.io/badge/Android-9.0%2B-3ddc84?logo=android&logoColor=white)](https://github.com/tioners/OpenFicM/releases/latest)
[![ABI](https://img.shields.io/badge/ABI-arm64--v8a-blue)](https://github.com/tioners/OpenFicM/releases/latest)
[![License](https://img.shields.io/badge/License-Apache--2.0-lightgrey)](LICENSE)

[下载安装](#下载) · [使用说明](docs/USER_GUIDE.md) · [更新日志](docs/releases) · [从源码构建](#从源码构建)

[English](README_EN.md)

</div>

---

OpenFicM 是基于 [OpenFic](https://github.com/syrizelink/OpenFic) 重构的 Android 小说创作应用，使用 React Native、Expo SQLite 和**运行在手机上的 Agent 运行时**。安装后不需要电脑、FastAPI、Socket.IO 或 Metro。

> 本项目是独立维护的衍生项目，并非 OpenFic 官方 Android 客户端。

## 它解决什么问题

手机上的 AI 写作工具大多是套壳聊天窗口：能生成文字，但作品资料、角色关系、世界设定都得你自己记着，再手动粘回提示词里。

OpenFicM 把桌面端那套 Agent 体系整个搬到了手机上——智能体能读取你的章节、角色和世界书，能按权限直接写回去，还能委派子智能体分工。作品数据全部留在手机，只有真正调用模型时才联网。

## 下载

前往 [Releases](https://github.com/tioners/OpenFicM/releases/latest) 下载 APK，直接安装即可，升级时覆盖安装、不要卸载。

| | |
| --- | --- |
| 系统要求 | Android 9.0 及以上 |
| 架构 | 仅 arm64-v8a（主流 64 位手机） |
| 安装包体积 | 约 126 MB |
| 签名证书 SHA-256 | `c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863` |

只从本项目 Releases 下载。提示签名冲突通常说明装的不是同一证书的包；卸载会清除本地作品，处理前先导出。

## 快速上手

1. **首次启动**：点"一键拉取并预热"，下载并校验 Agent/Skill 和本地检索模型（约 225 MB，来自 GitHub 和 Hugging Face）。
2. **配置模型**：设置 → 模型与供应商，填 Base URL 和 API Key，获取模型列表后设为默认模型。支持 OpenAI-compatible、Google Gemini、Anthropic 三种协议。
3. **开始写**：书架新建作品 → 助手里描述你的创作任务。

完整步骤见 [Android 使用说明](docs/USER_GUIDE.md)。

## 核心能力

### 真正的 Agent，不是聊天框

智能体可以按任务激活 Skill、调用本地工具、读取当前作品资料、委派子智能体，并按你设定的权限更新章节、角色和世界书。执行过程有实时 trace，能看到每一步调用了什么工具、返回了什么。

工具权限三档可调：允许 / 每次询问 / 禁止。建议写入类工具设为"每次询问"。

### 文风闭环

| 概念 | 来源 | 作用范围 |
| --- | --- | --- |
| 参考书 | 你导入的 TXT / Markdown / EPUB | 全局书库 |
| 参考文风 | 从参考书蒸馏出的可执行写作约束 | 可跨作品 |
| 作者文风 | 从 AI 原稿与你的定稿差异中学习 | 仅当前作品 |

参考文风支持**多轮继续蒸馏**：每轮读取连续 24 章，反复点击会向后随机推进、逐步铺满全书，新证据并入现有指南而不是推倒重来。完整小说不会上传，只发送当前窗口的样本。

作者文风则相反——它从你的实际修改里学。Agent 写完一章后你照自己习惯改，改完点"进化作者文风"，模型对比两版差异提炼出你的个人风格。

### 本地优先

作品、章节、角色、世界书、聊天记录、文风版本和检索索引全部保存在应用私有目录。API Key 存在 Android SecureStore，不写入 SQLite。中文嵌入和重排模型在手机 CPU 上运行，语义检索不需要外部向量数据库。

只有你主动发起模型请求时，才会把完成当前任务所需的上下文发给你自己配置的供应商。

### 移动端交互

章节默认预览模式避免误触，点编辑才进入输入框；自动保存、后台保存、输入法避让；卷章目录按卷分组；导出章节 / 卷 / 整本为 Markdown，通过系统分享面板交给文件管理器。

助手支持多会话、按会话切换模型、编辑历史发言重跑、失败任务持久化重试并可展开原始错误详情。

## 完整功能

<details>
<summary>展开查看</summary>

**书架与写作**

- 本地书架，卷分类，章节新建、重命名、删除
- 预览优先、自动保存、后台保存、输入法避让
- 章节 / 当前卷 / 整本导出为 Markdown，经系统分享面板保存

**助手与 Agent**

- 作品隔离的会话，按会话切换模型
- 结构化提问、实时 trace、工具权限审批
- 子智能体委派，由模型按任务判断是否需要
- 一次对话共享 24 次模型请求预算，避免打满中转站限流
- 失败任务持久化重试、历史发言编辑重跑、完成消息复制与重新生成

**资料与检索**

- 本地角色库、世界书，支持单条或批量导出为 JSON / Markdown
- 全文搜索 + 中文嵌入语义索引 + 重排精排
- 章节变化后的角色与世界书一致性检查

**文风系统**

- TXT / Markdown / EPUB 导入，兼容 UTF-8、UTF-16、GB18030/GBK
- 按 Lorn 方法蒸馏参考文风，支持多轮继续蒸馏与断点续跑
- AI 原稿与作者定稿关联，作品级作者文风版本进化
- 助手页与写作页动态选择并注入文风

**模型与设置**

- OpenAI-compatible / Google Gemini / Anthropic 三种协议
- 从供应商 API 获取模型列表，支持按名称或 ID 搜索
- 输出截断检测：思考型模型撞上限时明确提示调高最大输出 Token
- Gemini functionDeclaration 参数 schema 兼容修复
- 通用、连接、索引、上下文、工具权限、规则、技能、智能体、高级九类设置
- 高级设置内可检查应用更新和 oh-story 内容包更新

</details>

## 安全与隐私边界

- API Key 存 Android SecureStore，不以明文写入 SQLite。
- APK 不内置 GGUF 模型、Agent/Skill 或 catalog；首次启动从固定来源拉取并校验大小与 SHA-256。
- 远程内容只按白名单读取 Markdown，绑定不可变提交；远程 Hook、脚本和 Git 配置不会执行。
- 为兼容自建本地供应商，应用允许 HTTP Base URL；跨网络使用请优先配置 HTTPS。
- 卸载会删除本地数据，当前没有云同步。

## 从源码构建

需要 Node.js 22、Java 17、Android SDK 和 PowerShell。

~~~powershell
cd mobile-rn
npm ci
npm run type-check
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
~~~

本地测试用 `npm run android:apk:debug`，生成内置 JS、无需 Metro 的 `standalone` APK，使用调试证书，**禁止用于正式发布**。

<details>
<summary>正式签名与密钥轮换</summary>

Release 构建必须提供四个环境变量：`OPENFICM_RELEASE_STORE_FILE`、`OPENFICM_RELEASE_STORE_PASSWORD`、`OPENFICM_RELEASE_KEY_ALIAS`、`OPENFICM_RELEASE_KEY_PASSWORD`。缺任一项时 `app/build.gradle` 会拒绝 `assembleRelease`，这是防止误用调试证书发布的有意保护。

构建脚本会先清理 `android/app/build` 生成目录，并在复制产物前拒绝任何 GGUF 条目，防止旧增量资源重新进入 APK。

密钥轮换时除 `OPENFICM_RELEASE_LINEAGE_FILE` 外，还必须提供旧签名者的 `OPENFICM_RELEASE_LEGACY_STORE_FILE`、`OPENFICM_RELEASE_LEGACY_STORE_PASSWORD`、`OPENFICM_RELEASE_LEGACY_KEY_ALIAS` 和 `OPENFICM_RELEASE_LEGACY_KEY_PASSWORD`。脚本会用 lineage 中的旧、新签名者写入并验证签名继承链；没有旧签名者配置时应取消设置 lineage 变量。

GGUF、APK、签名文件和 local.properties 不进入 Git 仓库。所有固定来源和哈希值见 `mobile-rn/src/settings/remote-resources.ts`。

APK 输出位置：`OpenFicM-Android-<version>.apk`

</details>

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `mobile-rn` | OpenFicM Android 应用 |
| `docs` | 使用说明、版本说明、项目交接记录 |
| `backend`、`frontend`、`desktop` | 保留的 OpenFic 上游源码与兼容修复，便于追踪来源 |
| `THIRD_PARTY_NOTICES.md` | 第三方项目、内容和模型声明 |

## 鸣谢

- [syrizelink/OpenFic](https://github.com/syrizelink/OpenFic) — 原项目、产品设计和桌面端 Agent 体系，Apache-2.0
- [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) — 写作 Skill 与子智能体内容来源，MIT
- [lornshrimp/Lorn.NovelWriteSkills](https://github.com/lornshrimp/Lorn.NovelWriteSkills) — 参考文风蒸馏方法与白名单资料来源；上游固定提交的仓库根目录未声明许可证，详见第三方声明
- [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) 与 [BAAI/bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base) — 本地检索模型

## 社区

- [Linux Do](https://linux.do)

## 许可证

项目代码按 [Apache License 2.0](LICENSE) 发布。第三方内容继续适用各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
