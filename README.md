# OpenFicM

OpenFicM 是基于 OpenFic 重构的 Android 小说创作应用。它使用 React Native、Expo SQLite 和本地 Agent 运行时，安装后不依赖电脑、FastAPI、Socket.IO 或 Metro；只有调用用户配置的模型 API、获取供应商模型列表或检查 oh-story 内容更新时联网。

本项目是独立维护的衍生项目，并非 OpenFic 官方 Android 客户端。

## 下载

前往 [GitHub Releases](https://github.com/tioners/OpenFicM/releases) 下载 APK。

- 当前版本：0.5.0
- Android 9.0 及以上
- 仅提供 arm64-v8a，适用于主流 64 位 Android 手机
- 官方 APK 当前签名证书 SHA-256：c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863

## 功能

- 本地书架、卷分类、章节新建、命名、重命名和删除
- 手机端章节编辑、自动保存、后台保存和输入法避让
- 作品隔离的助手会话、模型切换和聊天记录管理
- 本地角色库、世界书、全文搜索、语义索引和重排
- 自定义 OpenAI-compatible、Google Gemini 和 Anthropic 供应商
- 从供应商 API 获取模型列表
- 通用、索引、上下文、工具权限、规则、技能、智能体和高级设置
- PC 内置 Agent/Skill 与 oh-story-claudecode 内容更新、版本校验和回滚
- 章节变化后的角色与世界书一致性检查
- Gemini functionDeclaration 参数 schema 兼容修复

API Key 使用 Android SecureStore 保存，不写入 SQLite。作品、章节、角色、世界书和聊天内容默认只保存在手机本地。
为兼容用户自定义的本地供应商，应用允许 HTTP Base URL；跨网络使用时请优先配置 HTTPS。

## 从源码构建

需要 Node.js 22、Java 17、Android SDK 和 PowerShell。

~~~powershell
cd mobile-rn
npm ci
npm run models:download
npm run type-check
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
~~~

模型下载脚本会校验两个 GGUF 文件的 SHA-256。GGUF、APK、签名文件和 local.properties 不进入 Git 仓库。

Release 构建必须提供 `OPENFICM_RELEASE_STORE_FILE`、`OPENFICM_RELEASE_STORE_PASSWORD`、`OPENFICM_RELEASE_KEY_ALIAS` 和 `OPENFICM_RELEASE_KEY_PASSWORD`。本地开发请使用 `npm run android:apk:debug`，避免误用调试证书发布。

密钥轮换时除 `OPENFICM_RELEASE_LINEAGE_FILE` 外，还必须提供旧签名者的
`OPENFICM_RELEASE_LEGACY_STORE_FILE`、`OPENFICM_RELEASE_LEGACY_STORE_PASSWORD`、
`OPENFICM_RELEASE_LEGACY_KEY_ALIAS` 和 `OPENFICM_RELEASE_LEGACY_KEY_PASSWORD`。
构建脚本会用 lineage 中的旧、新签名者写入并验证签名继承链；没有旧签名者配置时应取消设置 lineage 变量。官方签名私钥和轮换链不会提交到仓库。

APK 输出位置：

~~~text
OpenFicM-Android-0.5.0.apk
~~~

## 目录

- mobile-rn：OpenFicM Android 应用
- backend、frontend、desktop：保留的 OpenFic 上游源码与兼容修复，便于追踪来源
- THIRD_PARTY_NOTICES.md：第三方项目、内容和模型声明

## 鸣谢

- [syrizelink/OpenFic](https://github.com/syrizelink/OpenFic)：原项目、产品设计和桌面端 Agent 体系，Apache-2.0
- [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)：写作 Skill 与子智能体内容来源，MIT
- [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) 与 [BAAI/bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base)：本地检索模型

## 许可证

项目代码按 Apache License 2.0 发布。第三方内容继续适用各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
