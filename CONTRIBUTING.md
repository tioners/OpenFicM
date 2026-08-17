# Contributing

提交问题前请搜索现有 Issue，并移除日志、截图中的 API Key、令牌和小说隐私内容。

开发 Android 端：

~~~powershell
cd mobile-rn
npm ci
npm run models:download
npm run type-check
~~~

提交要求：

- 改动保持聚焦，遵循现有 TypeScript 和 React Native 模式
- 涉及数据库写入时使用事务，并同步清理全文或向量索引
- 不提交 GGUF、APK、keystore、local.properties、环境变量或凭据
- PR 标题使用 Conventional Commits，例如 feat(writing): add volume management
- 对用户可见的行为变化同步更新 README 或 DESIGN.md
