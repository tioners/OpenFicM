# OpenFicM Android

这是 OpenFicM 的 React Native Android 工程。应用不依赖电脑后端，业务数据保存在本机 SQLite，API Key 保存在 Android SecureStore。

面向普通用户的安装、模型配置、Agent、文风、导出和故障排查说明见 [Android 使用说明](../docs/USER_GUIDE.md)，0.7.3 更新内容见 [版本说明](../docs/releases/v0.7.3.md)。

## 开发

~~~powershell
npm ci
npm run type-check
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
~~~

模型文件不会提交到 Git，也不会打进 APK。首次启动时，应用从 Hugging Face 下载以下文件到应用私有目录，并校验文件大小和 SHA-256：

- bge-small-zh-v1.5-q4_k_m.gguf
- bge-reranker-base-q4_k_m.gguf

正式构建脚本会先清理 android/app/build 生成目录，并在输出前检查 APK；只要发现任何 GGUF 条目就会直接失败，避免旧增量资源被误发布。

## 正式签名

官方构建通过以下环境变量读取仓库外的私钥：

- OPENFICM_RELEASE_STORE_FILE
- OPENFICM_RELEASE_STORE_PASSWORD
- OPENFICM_RELEASE_KEY_ALIAS
- OPENFICM_RELEASE_KEY_PASSWORD
- OPENFICM_RELEASE_LINEAGE_FILE（仅密钥轮换时需要）
- OPENFICM_RELEASE_LEGACY_STORE_FILE（使用 lineage 时必需）
- OPENFICM_RELEASE_LEGACY_STORE_PASSWORD（使用 lineage 时必需）
- OPENFICM_RELEASE_LEGACY_KEY_ALIAS（使用 lineage 时必需）
- OPENFICM_RELEASE_LEGACY_KEY_PASSWORD（使用 lineage 时必需）

Release 构建缺少前四项时会直接失败；使用 lineage 时必须同时提供旧签名者的四项配置，否则构建会明确失败。本地手动安装测试使用 `npm run android:apk:debug`，它构建内置 JS 且无需 Metro 的 `standalone` APK并使用调试证书。不得把该 APK 用于发布，也不得提交 keystore、密码、签名轮换链、APK 或 GGUF。

## 网络边界

- 模型 API：只连接用户配置的供应商地址
- 模型发现：读取供应商模型列表
- 运行资源：从 OpenFicM GitHub、oh-story GitHub Release、Lorn.NovelWriteSkills 固定 commit 和 Hugging Face 获取，下载不执行远程脚本或 Hook
- oh-story 更新：只读取正式 Release 和白名单 Markdown，绑定不可变 commit/tree SHA

## 文风工作流

- 文风书库接受 TXT、Markdown 和 EPUB；原文件及规范化正文保存在应用私有目录。
- 蒸馏只把分布式抽样文本发送给用户配置的默认模型，完整参考书不会上传。
- 参考文风可跨作品选择；作者文风按作品保存多个版本。助手生成正文前会在尚未选择时询问，写作页和助手页也可直接切换。
- Agent 创建或重写章节时保存 AI 原稿与所用文风；作者修改后可在写作页生成新的作者文风版本。
- Android 运行时不使用 FastAPI、服务地址、Socket.IO 或电脑后端。

详细架构见 DESIGN.md，第三方声明见 ../THIRD_PARTY_NOTICES.md。
