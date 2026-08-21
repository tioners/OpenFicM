<div align="center">

# OpenFicM

**A local-first Android app for writing fiction on your phone**

[![Release](https://img.shields.io/github/v/release/tioners/OpenFicM?label=release&color=2e7d5b)](https://github.com/tioners/OpenFicM/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/tioners/OpenFicM/total?color=2e7d5b)](https://github.com/tioners/OpenFicM/releases)
[![Android](https://img.shields.io/badge/Android-9.0%2B-3ddc84?logo=android&logoColor=white)](https://github.com/tioners/OpenFicM/releases/latest)
[![ABI](https://img.shields.io/badge/ABI-arm64--v8a-blue)](https://github.com/tioners/OpenFicM/releases/latest)
[![License](https://img.shields.io/badge/License-Apache--2.0-lightgrey)](LICENSE)

[Download](#download) · [User guide (Chinese)](docs/USER_GUIDE.md) · [Changelog](docs/releases) · [Build from source](#build-from-source)

[简体中文](README.md)

</div>

---

OpenFicM is an independent Android adaptation of [OpenFic](https://github.com/syrizelink/OpenFic), built with React Native, Expo SQLite, and an **on-device Agent runtime**. The installed APK needs no PC, FastAPI, Socket.IO, or Metro.

> This is an independently maintained derivative project, not an official OpenFic Android client. The interface and documentation are in Simplified Chinese.

## What it solves

Most mobile AI writing tools are chat wrappers: they generate text, but you have to keep track of your own characters, relationships, and world rules — and paste them back into the prompt yourself.

OpenFicM ports the desktop Agent system to the phone. The agent reads your chapters, characters, and world entries, writes back to them under permissions you control, and can delegate to sub-agents. Your work stays on the device; the network is used only when you actually call a model.

## Download

Get the APK from [Releases](https://github.com/tioners/OpenFicM/releases/latest). Install over the previous version — do not uninstall first, that wipes local data.

| | |
| --- | --- |
| Requires | Android 9.0 or newer |
| ABI | arm64-v8a only |
| APK size | ~126 MB |
| Signing certificate SHA-256 | `c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863` |

Download only from this project's Releases. A signature conflict means the installed package uses a different certificate.

## Quick start

1. **First launch** — tap the one-tap fetch button to download and verify Agents/Skills and the local retrieval models (~225 MB, from GitHub and Hugging Face).
2. **Configure a model** — Settings → Models & Providers. Enter a Base URL and API Key, fetch the model list, then set a default model. OpenAI-compatible, Google Gemini, and Anthropic protocols are supported.
3. **Start writing** — create a project on the shelf, then describe your task in the assistant.

## Core capabilities

### A real agent, not a chat box

The agent activates Skills per task, calls local tools, reads the current project's data, delegates to sub-agents, and updates chapters, characters, and world entries under the permissions you set. A live trace shows every tool call and result.

Tool permissions have three levels: allow / ask every time / deny. Write-capable tools are best left on "ask".

### Somewhere to keep the outline

Beyond chapters, characters, and world entries there is a fourth category: outlines, plot direction, foreshadowing lists — things that **haven't happened in the text yet**. Put them in the world entries and the agent treats them as established canon.

Notes attach to the book's existing structure at three levels: whole book for the overall outline, volume for that volume's arc and foreshadowing, chapter for what a specific chapter must achieve. Notes can move between levels. Deleting a chapter or volume asks whether to keep or remove its notes; keeping them promotes them one level up.

The agent can read and write notes, but only note titles go into the prompt — content is fetched on demand, so a large note collection does not slow down every turn.

### Style pipeline

| Concept | Source | Scope |
| --- | --- | --- |
| Reference book | TXT / Markdown / EPUB you import | Global library |
| Reference style | Constraints distilled from a reference book | Across projects |
| Author style | Learned from the diff between AI draft and your final edit | Current project only |

Reference-style distillation runs in **repeatable rounds**: each round reads 24 consecutive chapters, and tapping again advances forward through the book, merging new evidence into the existing guide rather than starting over. The full novel is never uploaded — only the current window's samples.

Author style works the other way: the agent writes a chapter, you edit it your way, and the model compares the two versions to extract your personal voice.

### Local first

Projects, chapters, characters, world entries, chat history, style versions, and the search index all live in the app's private directory. API keys are stored in Android SecureStore, never in SQLite. Chinese embedding and reranking models run on the phone's CPU, so semantic search needs no external vector database.

Only when you initiate a model request does the app send the context needed for that task to the provider you configured.

### Mobile-shaped editing

Chapters open in preview mode to avoid mis-taps; tap edit to type. Autosave, background save, and keyboard avoidance are built in. Export a chapter, a volume, or the whole novel as Markdown through the Android share sheet.

The assistant supports multiple sessions, per-session model selection, editing past messages to re-run, and persistent retry with expandable raw error details.

## Security and privacy boundaries

- API keys live in Android SecureStore, not in plaintext SQLite.
- The APK ships no GGUF models, Agents/Skills, or catalogs; they are fetched on first launch from pinned sources and verified by size and SHA-256.
- Remote content is read from an allowlist of Markdown files pinned to immutable commits. Remote hooks, scripts, and Git configuration are never executed.
- HTTP Base URLs are allowed so self-hosted providers work; prefer HTTPS across networks.
- Uninstalling deletes local data. There is no cloud sync.

## Build from source

Requires Node.js 22, Java 17, the Android SDK, and PowerShell.

~~~powershell
cd mobile-rn
npm ci
npm run type-check
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
~~~

For local testing use `npm run android:apk:debug`, which produces a `standalone` APK with bundled JS and a debug certificate. **Never publish that build.**

<details>
<summary>Release signing and key rotation</summary>

Release builds require four environment variables: `OPENFICM_RELEASE_STORE_FILE`, `OPENFICM_RELEASE_STORE_PASSWORD`, `OPENFICM_RELEASE_KEY_ALIAS`, `OPENFICM_RELEASE_KEY_PASSWORD`. Without all four, `app/build.gradle` refuses `assembleRelease` — a deliberate guard against shipping a debug-signed build.

The build script clears the generated `android/app/build` directory first and rejects any GGUF entry before copying artifacts, so stale incremental resources cannot re-enter the APK.

Key rotation additionally requires the previous signer's `OPENFICM_RELEASE_LEGACY_STORE_FILE`, `OPENFICM_RELEASE_LEGACY_STORE_PASSWORD`, `OPENFICM_RELEASE_LEGACY_KEY_ALIAS`, and `OPENFICM_RELEASE_LEGACY_KEY_PASSWORD` alongside `OPENFICM_RELEASE_LINEAGE_FILE`. Unset the lineage variable when no legacy signer is configured.

GGUF files, APKs, signing material, and local.properties stay out of Git. Pinned sources and hashes are in `mobile-rn/src/settings/remote-resources.ts`.

Output: `OpenFicM-Android-<version>.apk`

</details>

## Repository layout

| Path | Purpose |
| --- | --- |
| `mobile-rn` | The OpenFicM Android app |
| `docs` | User guide, release notes, project handover record |
| `backend`, `frontend`, `desktop` | Retained OpenFic upstream sources and compatibility fixes |
| `THIRD_PARTY_NOTICES.md` | Third-party project, content, and model notices |

## Credits

- [syrizelink/OpenFic](https://github.com/syrizelink/OpenFic) — original project, product design, and desktop Agent system, Apache-2.0
- [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode) — writing Skills and sub-agent content, MIT
- [lornshrimp/Lorn.NovelWriteSkills](https://github.com/lornshrimp/Lorn.NovelWriteSkills) — reference-style distillation method and allowlisted material; the pinned upstream commit declares no license at the repository root, see the third-party notices
- [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) and [BAAI/bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base) — local retrieval models

## License

Project code is released under the [Apache License 2.0](LICENSE). Third-party content remains under its own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
