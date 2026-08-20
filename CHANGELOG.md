# Changelog

## 0.7.0 - 2026-08-20

- Moved Agent/Skill and local retrieval models out of the APK. Added startup resource integrity checks, one-click GitHub/Hugging Face download, temporary-file SHA-256 verification and automatic model warm-up.
- Added the original Lorn.NovelWriteSkills distillation Skill and allowlisted references, pinned to commit `5acd34586d5d241193bd36ceed9341f7f482ea3b`; the upstream repository root does not declare a license.
- Added the isolated Lorn style distillation and evolution plugin with per-project style guides and optional FastAPI integration.
- Added persistent assistant retry actions, message copying, and human-readable network errors with expandable details.
- Added JSON and Markdown exports for individual or all character and world-info entries.
- Pinned first-run catalogs to an immutable OpenFicM commit while retaining SHA-256 verification.
- Made edited user-message branch replacement atomic and closed an autosave race that could leave the newest draft unsaved.
- Preserved Gemini thought signatures across tool turns and retained native network failure details for retry diagnostics.
- Hardened release builds against stale Android outputs and fails the build if any local GGUF model is bundled.

## 0.6.0 - 2026-08-19

- 增加当前章节、当前卷和整本小说的 Markdown 导出
- 写作页默认使用预览模式，点击编辑后再进入正文编辑器
- 增加助手 API 失败后的原请求重试，不重复保存用户消息
- 增加历史用户发言编辑，并从编辑点重新运行 Agent

## 0.5.0 - 2026-08-18

- 完善 Agent 运行轨迹、结构化提问、工具权限和作品隔离助手体验
- 修复角色与世界书删除后的向量索引残留，并增强设置保存失败提示
- 修复移动端 Gemini 工具参数 schema 兼容问题
- 同步正式版本号、Android 9+ 最低版本和签名轮换文档

## 0.4.0 - 2026-08-18

- 增加按卷分组的移动端作品目录
- 增加卷与章节的新建、重命名和删除
- 删除或修改章节时同步清理全文与向量索引
- 将 Android 产品名更新为 OpenFicM
- 增加可校验的本地 GGUF 下载流程
- 完成开源许可证、第三方声明、签名隔离和移动端 CI
- 修正内置智能体的 OpenFicM 身份与反馈地址
- 使用独有正式证书替换公开模板私钥，并提供安全的签名轮换链构建流程

## 0.3.0 - 2026-08-17

- 增加作品隔离的助手会话、模型切换和聊天记录管理
- 导入 PC 内置技能与智能体，支持子智能体协作
- 增加 oh-story Release 检查、白名单更新与回滚
- 内置本地嵌入和重排模型
- 修复章节变化后的角色与世界书一致性检查
