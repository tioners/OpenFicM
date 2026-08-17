# OpenFicM

OpenFicM is an independent Android adaptation of OpenFic. It uses React Native, Expo SQLite, and an on-device Agent runtime. The installed APK does not require a PC, FastAPI, Socket.IO, or Metro. Network access is used only for user-configured model APIs, provider model discovery, and optional oh-story content updates.

This is an independently maintained derivative project, not an official OpenFic Android client.

## Download

Download the APK from [GitHub Releases](https://github.com/tioners/OpenFicM/releases).

- Current version: 0.5.0
- Android 9.0 or newer
- arm64-v8a only
- Official APK certificate SHA-256: c5dd7c047dc88fdeee64bd4311cddbe7ebc3ba60ea1485670b7543870dddf863

## Highlights

- Local bookshelf with volume and chapter creation, rename, and deletion
- Mobile chapter editor with auto-save and keyboard avoidance
- Project-scoped assistant sessions, model selection, and chat history
- Local characters, world book, full-text search, embeddings, and reranking
- Custom OpenAI-compatible, Google Gemini, and Anthropic providers
- Provider model discovery
- Rules, skills, agents, tool permissions, context, indexing, and advanced settings
- Built-in PC Agent/Skill content plus verified oh-story updates and rollback
- Character and world-book consistency checks after chapter changes
- Gemini functionDeclaration schema compatibility fix

API keys are stored with Android SecureStore rather than SQLite. Project content remains on the device unless it is sent to a model provider selected by the user.
HTTP Base URLs are allowed for local custom providers; use HTTPS whenever the provider is reachable across a network.

## Build

Node.js 22, Java 17, Android SDK, and PowerShell are required.

~~~powershell
cd mobile-rn
npm ci
npm run models:download
npm run type-check
cd android
.\gradlew.bat -I .\gradle\mirrors.init.gradle assembleRelease --no-daemon
~~~

The model downloader verifies both GGUF files by SHA-256. GGUF files, APKs, signing keys, and local.properties are excluded from Git.

Without OPENFICM_RELEASE_* environment variables, release builds use the local Android debug certificate. Distributors must provide their own private keystore. The official OpenFicM signing key is not published.

## Credits

- [syrizelink/OpenFic](https://github.com/syrizelink/OpenFic), the upstream project and Agent architecture, Apache-2.0
- [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode), writing skills and delegated-agent content, MIT
- [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5) and [BAAI/bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base), local retrieval models

## License

OpenFicM code is released under Apache License 2.0. Third-party materials remain under their respective licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
