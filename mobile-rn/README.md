# OpenFicM Android

这是 OpenFicM 的 React Native Android 工程。应用不依赖电脑后端，业务数据保存在本机 SQLite，API Key 保存在 Android SecureStore。

## 开发

~~~powershell
npm ci
npm run type-check
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
~~~

模型文件不会提交到 Git，也不会打进 APK。首次启动时，应用从 Hugging Face 下载以下文件到应用私有目录，并校验文件大小和 SHA-256：

- bge-small-zh-v1.5-q4_k_m.gguf
- bge-reranker-base-q4_k_m.gguf

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

Release 构建缺少前四项时会直接失败；使用 lineage 时必须同时提供旧签名者的四项配置，否则构建会明确失败。本地开发请使用 `npm run android:apk:debug`。不得提交 keystore、密码、签名轮换链、APK 或 GGUF。

## 网络边界

- 模型 API：只连接用户配置的供应商地址
- 模型发现：读取供应商模型列表
- 运行资源：从 OpenFicM GitHub、oh-story GitHub Release、Lorn.NovelWriteSkills 固定 commit 和 Hugging Face 获取，下载不执行远程脚本或 Hook
- oh-story 更新：只读取正式 Release 和白名单 Markdown，绑定不可变 commit/tree SHA

详细架构见 DESIGN.md，第三方声明见 ../THIRD_PARTY_NOTICES.md。
