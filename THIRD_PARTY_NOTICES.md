# Third-Party Notices

## OpenFic

OpenFicM is derived from [syrizelink/OpenFic](https://github.com/syrizelink/OpenFic). OpenFic is licensed under the Apache License, Version 2.0. The full Apache-2.0 text is included in LICENSE.

OpenFicM is independently maintained and is not represented as an official OpenFic release.

## oh-story-claudecode

The built-in and updateable writing Skill and delegated-agent content includes adapted material from [worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode).

MIT License

Copyright (c) 2025-2026 oh-story-claudecode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Runtime GGUF Models

The APK does not bundle these models. The app downloads them on demand from Hugging Face after the user starts the resource installation flow:

- [CompendiumLabs/bge-small-zh-v1.5-gguf](https://huggingface.co/CompendiumLabs/bge-small-zh-v1.5-gguf), based on BAAI/bge-small-zh-v1.5
- [sabafallah/bge-reranker-base-Q4_K_M-GGUF](https://huggingface.co/sabafallah/bge-reranker-base-Q4_K_M-GGUF), based on BAAI/bge-reranker-base

Exact filenames, sizes and SHA-256 values are recorded in mobile-rn/assets/models/LICENSES.md and mobile-rn/src/settings/remote-resources.ts.

## Lorn.NovelWriteSkills

The optional Lorn style package downloads the “通用-蒸馏作者文风” Skill and a small allowlist of references from [lornshrimp/Lorn.NovelWriteSkills](https://github.com/lornshrimp/Lorn.NovelWriteSkills) at commit `5acd34586d5d241193bd36ceed9341f7f482ea3b`. The upstream repository root did not declare a LICENSE at that commit. The package is user-initiated, is not bundled in the APK, and remains subject to the upstream author's terms; confirm permission before redistribution.
