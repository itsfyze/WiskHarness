# WiskHarness 0.7.3 development

## Current milestone

Stable 0.7.3 is published. The tagged source and all four public artifacts were verified. The published beta.7 Portable upgraded through the live GitHub feed.

## Completed milestones

- Confirmed the beta.7 checkout is clean at 2445c6f and the stable tag does not exist. All 21 beta.7 regression tests passed.
- Inspected the Electron entry point, Express API, SSE run lifecycle, native Ollama loop, Goose ACP integration, session storage, permissions, workspace review, web tools and release staging.
- Verified the official Vibe Windows x64 archive against GitHub's SHA-256 and ran its ACP executable with --help. Matched the release to upstream commit fb7511a791f80516a57b06525707215b6a00ebd1.

## Architecture

Electron owns the window, backend process and update handoff. Express owns settings, workspace authorization, sessions and streamed events. The existing backend already provides validated coding tools, checkpoint storage, web SSRF protection and review snapshots. Retain those boundaries and let Vibe run inference, tool selection, compaction and its native session lifecycle. Keep the native Ollama and Goose paths available during migration.

Vibe can run built-in operations without an ACP approval callback. An isolated configuration and explicitly registered WiskHarness tools give the desktop a place to enforce permissions on every operation. Verify the tool allowlist and actual model-visible schemas before enabling the runtime by default.

References: [Vibe Windows release](https://github.com/mistralai/mistral-vibe/releases/tag/v3.1.5), [offline model configuration](https://docs.mistral.ai/vibe/code/cli/offline-models), [ACP protocol](https://agentclientprotocol.com/), [Ollama](https://docs.ollama.com/).

## Objectives at the audit checkpoint

- Vibe runtime startup, approved tools, model discovery/configuration and measured inference status.
- Agent, Plan and Ask, session restoration, desktop redesign, live changes and diff review, web search and MCP management.
- Isolated live model and desktop verification, Windows packages, beta.7 migration, release and public checksum verification.

## Limitations observed at the audit checkpoint

The baseline currently captures workspace changes at turn completion. Vibe startup with an Ollama provider and execution through WiskHarness have yet to be verified.

## Implementation checkpoint

- Vibe ACP operates against a loopback adapter for Ollama native chat. The adapter sets the selected Ollama context and maps registered structured tool calls to Vibe MCP. ACP approves only known WiskHarness MCP tool names. The actual tool still uses WiskHarness's permission checks before reaching a file or terminal.
- The initial Vibe run exposed programmatic MCP routing and a redundant approval prompt. Normalized that bridge, then verified Qwen 3.5 9B wrote and read a file and read it again after native session restoration. The loaded Ollama context reported 16,384 tokens.
- Devstral Small 2 24B ran real tools and advanced beyond directory creation. It handled missing CMake, fixed a Python syntax error, compiled, ran unit tests, created the ZIP and checked it. The fixture failed because the model created the test's intentionally missing path. The revised fixture specifies that the path must remain absent and verifies GUI startup.
- GPT-OSS 20B 8K was rejected by Vibe 3.1.5's 13,334-token minimum. The native Ollama runtime is available for small-context presets. Base GPT-OSS and revised Devstral acceptance are running separately.
- Added first-pass desktop navigation and theme tokens, grouped/pinned/archived chats, persistent composer inference details, a collapsible development panel, live workspace snapshots, diff review and a read-only file browser. Added Vibe models and settings, remote Ollama configuration, Brave Search and MCP management. These surfaces still need packaged verification.
- Windows staging verified the official Vibe executable and the first 0.7.3 candidate build began. Release tag and publication are pending automated, packaged, visual and migration checks.

## Acceptance evidence before publication

- The historical Devstral beta.7 session stopped with recovery_stalled after 12 rounds and 16 tool calls. Eight directory listings and two reads completed, two read attempts failed, and the checkpoint reached its configured recovery limit of six. No source write was recorded.
- The pinned Vibe contract passed through the real Windows ACP executable with controlled Ollama output. It covered Ask approval, denied workspace escape, streamed review, conflict-safe reversion, read-only Plan, tool-free Ask, and removal of protocol markup from visible text.
- Qwen 3.5 9B and GPT-OSS 20B performed real file creation, read-back and a follow-up through Vibe after session restoration.
- The revised live Devstral task built a multi-file Tkinter application, recovered from a planted syntax error, unavailable CMake and an incorrect path, then compiled, tested, launched the GUI in smoke mode and produced and verified a ZIP. An independent replay passed compilation, three unit tests, the GUI smoke flag and the archive integrity check. Vibe also ran automatic compaction after these tool results.
- A disposable SearXNG instance returned real general search results for a Windows question and a travel question. WiskHarness consumed its JSON API through the configured loopback endpoint. Brave Search tests exercised its request and response contract with a fixture.
- The standard regression suite passed 24 tests and skipped the Windows Vibe integration until its verified runtime was provided. The separate bundled-runtime test run passed all four cases.

## Windows release gates

- Packaged desktop verification passed with the archive-based Vibe runtime at 1920×1080 and 2560×1440. Captures include the Composer, approvals, live speed, review modes, file explorer, terminal, model settings, themes, MCP and update controls.
- The final packaged Vibe test passed with a clean profile, including first-use archive verification, managed MCP discovery and invocation, write approvals, blocked workspace escape and conflict-safe reversion.
- Stable Setup applied and reopened from a beta.7 fixture under a disposable installer GUID. The test rejected an interrupted download, observed progress and verified the saved settings and conversation byte for byte.
- Compressed Portable candidates missed beta.7's restart verification window. The official runtime now ships as a verified archive, and the Portable wrapper extracts stored files directly. The tested Portable release artifact is about 501 MiB. Its controlled beta.7 upgrade rejected a bad download, replaced and verified the exact new executable, reopened in about seven seconds, and preserved the saved settings and conversation.
- Normal tests passed. One bundled-runtime test is skipped until the verified Windows runtime is supplied, then passes in the dedicated stage. The live Devstral recovery run produced working code and a valid package. After automatic compaction, the test client timed out before its final response, so the independent checks establish the project outcome.
- The stable release was published at v0.7.3, commit 844ae5bfeaa46e50bb4805d6e88fe53c219c5e78. Anonymous full downloads verified Setup, Portable, SHA256SUMS.txt and update-manifest.json. The original public beta.7 Portable matched its published digest, found the stable release on the real GitHub feed, shut down, applied the exact stable executable and reopened at 0.7.3. Saved settings and conversation bytes were unchanged.
