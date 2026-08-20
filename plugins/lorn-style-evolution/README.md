# Lorn Style Evolution

This plugin provides an isolated home for author-style distillation and style-evolution features inspired by Lorn.NovelWriteSkills.

## Boundaries

- The plugin must not modify or replace any `oh-story-claudecode` managed Skill or Agent content.
- Markdown Skill prompts belong in `skills/`.
- Python processing and OpenAI-compatible API integration belong in `backend/`.
- Registration with OpenFicM's Agent runtime is described by `mobile-catalog.json`; the Android app downloads the catalog and the Lorn upstream files at runtime, so neither the plugin catalog nor Skill text is bundled in the APK.

## Status

The Android runtime downloads the managed catalog plus the original Lorn distillation Skill and an allowlisted set of references from pinned commits. It stores imported reference books, style versions, AI drafts, and author revisions locally, while model analysis uses the provider configured in OpenFicM.

The mobile application has no backend URL setting and does not call FastAPI. The `backend/` directory is retained only as historical development reference; it is not bundled, downloaded, or used by the Android runtime.
