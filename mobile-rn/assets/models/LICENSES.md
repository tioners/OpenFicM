# Runtime retrieval models

The Android package does not include these GGUF models. On first launch, OpenFicM downloads them from Hugging Face into the app-private document directory and verifies the recorded size and SHA-256 before use:

- `bge-small-zh-v1.5-q4_k_m.gguf`
  - Source: `CompendiumLabs/bge-small-zh-v1.5-gguf`
  - Base model: `BAAI/bge-small-zh-v1.5`
  - License: MIT
  - Size: `15,448,256` bytes
  - SHA-256: `0c17cc6ed7ec697db6768c2db6dd22c4e816a12c68ed14ff4d764927338532f8`
- `bge-reranker-base-q4_k_m.gguf`
  - Source: `sabafallah/bge-reranker-base-Q4_K_M-GGUF`
  - Base model: `BAAI/bge-reranker-base`
  - License: MIT
  - Size: `219,068,480` bytes
  - SHA-256: `18a10177d2494696616d252d55d42dc1046efe8b6b005aa911b5c167dc731f1c`
