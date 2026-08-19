# Lorn Style Evolution

This plugin provides an isolated home for author-style distillation and style-evolution features inspired by Lorn.NovelWriteSkills.

## Boundaries

- The plugin must not modify or replace any `oh-story-claudecode` managed Skill or Agent content.
- Markdown Skill prompts belong in `skills/`.
- Python processing and OpenAI-compatible API integration belong in `backend/`.
- Registration with OpenFicM's Agent runtime is described by `mobile-catalog.json`; the Android app downloads the catalog and the Lorn upstream files at runtime, so neither the plugin catalog nor Skill text is bundled in the APK.

## Status

Phase 2 adds the isolated `skills/style-distillation.md` prompt. Phase 3 adds the optional OpenAI-compatible backend endpoint in `backend/style_evolution.py`. Phase 4 registers both capabilities through `mobile-catalog.json`; OpenFicM downloads this managed catalog on demand without changing the oh-story package. The Android runtime also installs the original Lorn distillation Skill and an allowlisted set of references from the pinned upstream commit.

## Backend configuration

Set these environment variables for the backend endpoint:

- `OPENFICM_STYLE_API_BASE_URL`
- `OPENFICM_STYLE_API_KEY`
- `OPENFICM_STYLE_MODEL`

The backend sends only the three request fields to the configured provider and does not log the API key. It does not execute or download remote Skills.

Run the optional endpoint from the repository root with a Python environment containing FastAPI, HTTPX, Pydantic, and Uvicorn:

```powershell
uvicorn style_evolution:app --app-dir plugins/lorn-style-evolution/backend --host 0.0.0.0 --port 8000
```

In OpenFicM, open Settings > Author Style and enter the reachable server base URL. If no endpoint is configured, the Android Agent uses the currently selected model for style evolution and remains independent of FastAPI.

Do not expose the endpoint directly to the public internet without adding authentication and TLS. Requests contain the AI draft, author revision, and current style guide.
