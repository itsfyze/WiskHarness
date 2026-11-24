# Changelog

## 0.7.3

- Bundle Mistral Vibe as the primary Agent runtime for tool-capable Ollama models. Keep native Ollama and Goose as fallback choices.
- Add an optional development panel for live changes, diff review, file previews, terminal output and task progress.
- Add Ink and Paper themes, grouped chats, pins and archives. Keep the existing themes and composer controls.
- Show live speed estimates and measured Ollama speed below the composer. Use Agent to execute, Plan to inspect and propose, or Ask for a tool-free answer.
- Support configured SearXNG and Brave Search, remote Ollama endpoints, per-model Vibe options and a managed list of approved MCP servers.
- Keep the Windows updater, existing chats, task checkpoints and profile settings.

## 0.7.3-beta.7

- Continue through interim summaries and ordinary tool failures within bounded recovery and execution budgets.
- Run routine workspace development commands without repeated prompts in Full Access. Keep approval for other shell operations.
- Track recovery use, context, and verified packaging evidence in task checkpoints.

## 0.7.3-beta.6

- Download and verify updates in the background, then install and restart WiskHarness.
- Install Setup releases in place and replace the Portable executable with a recoverable backup.
- Show release notes, download speed, progress, verification, and recovery controls.
- If work is active when a download finishes, finish or cancel it before installing.
- To move from beta.5 or older to beta.6, run the verified Setup installer or replace the Portable executable once. Automatic installation starts with beta.6.

## 0.7.3-beta.5

- Continue after premature progress summaries and require tool evidence for implementation, compilation, tests, and packaging when requested.
- Save the execution checklist and stop reason. Continue an incomplete task from its chat and workspace.

## 0.7.3-beta.4

- Made native Ollama tool calling the default Agent engine. Models that return prose on the native path can use structured JSON compatibility.
- Separated the current request from project memory, added per-chat workspace selection and made project creation available from the Projects view.
- Added explicit completion checks, error recovery, cancellation and configurable model-round, tool-call and time limits.
- Added a GitHub release workflow that checks tracked source, publishes the Windows packages and checksums, and verifies the public downloads.

## 0.7.3-beta.3

- Centered the new-chat home around one composer with mode, model and performance controls. Agent home also shows attachments, permissions and Internet access.
- Added mode-specific prompt shortcuts that fill an editable draft, plus a direct path to Goose setup when portable Goose is missing.
- Kept saved-chat restoration and the existing conversation layout. New-chat drafts stay visible while choosing whether to send to a cloud provider.

## 0.7.3-beta.2

- Added optional Internet access in the Agent composer and Settings. The preference defaults off, persists, and takes effect on the next Agent turn.
- Added Goose ACP tools to search public GitHub issues and pull requests or Wikipedia, query an optional SearXNG service, and open public text pages with source URLs.
- Added public-address and redirect validation, connection deadlines, response limits, and readable tool errors. Shell networking remains governed by Windows and the selected Agent permissions.

## 0.7.3-beta.1

- Added installed, portable and custom Goose runtime choices to setup and Settings. Automatic prefers a compatible installed copy. The official portable download requires confirmation and verifies both the archive and the extracted executable.
- Added Goose version and ACP compatibility checks before Agent startup and kept native sessions in the existing WiskHarness profile.
- Refined the desktop navigation, Plan and Agent workspaces, composer, project and model views, settings, setup, diagnostics, selectors and approval surfaces. All seven themes remain available.
- Added a release step that builds the icon-equipped version-matched Windows uninstall launcher and generates SHA-256 checksums for all three executables.

## 0.7.2-beta.2

- Fixed Full access auto-approval for real Goose ACP shell and other opaque tool requests. Previously these were automatically denied despite Full access being selected.
- Kept Ask and Approve for me behavior, explicit deny rules, and inspectable protected-path checks; Plan mode remains tool-free.
- Clarified the Full access confirmation: shell commands run under the Windows account and can bypass workspace and credential restrictions through their effects. This is not a process sandbox.
- Added automated policy and real Goose shell-execution regression checks. Local Windows beta builds only; publication status is tracked separately.

## 0.7.2-beta.1

- Added three Agent permission modes, exact workspace-scoped rules, revocation, and a persistent Full access indicator.
- Added formatted Markdown to streaming and saved chats, with sanitized links, syntax highlighting, tables and code copying.
- Fixed model visibility toggles so they preserve search, scroll and active generation.
- Added a compact performance panel with Ollama timing and token counts, optional ACP measurements, context and host CPU and RAM.
- Fixed partial Obsidian checkpoint recovery on Windows. Chat completion and checkpoint failures have separate statuses. Project notes update their current status fields and retain history.
- Refined composer selectors and shared chevrons across the seven themes.

## 0.7.1 beta candidate

- Added tool-free Plan adapters for LM Studio, compatible loopback APIs, OpenAI, Anthropic, Google Gemini and OpenRouter. Agent mode still uses Goose ACP and Ollama.
- Added separate Plan and Agent defaults, cloud consent, Windows-protected API keys, and timestamped Plan model checks.
- Added rules for Goose approval requests, canonical path checks, and pattern-based secret protection for supported outputs. Agent process and network isolation remain unavailable.
- Added Git status, diff review, stage, unstage and confirmation before creating an unsigned commit.
- Added settings for global Agent instructions, path-free diagnostics preview, and versioned transcript and preferences backups.
- Restricted bundled files to the application runtime, frontend and production dependencies.

This candidate requires public-release review. Subscription sign-in, live paid-provider validation, Agent compatibility checks across models and OS-level Agent isolation remain open.

## 0.7.0

- Renamed the desktop app to WiskHarness and added the approved blue hexagonal code logo.
- Added first-run dependency checks, optional Obsidian configuration, local setup diagnostics, and Tailscale status.
- Added the Agent checklist, resume prompt, integrated terminal, file snapshots and rollback checks for supported edits.
- Added Ollama runtime measurements, requested context settings and GitHub release checks with verified manual downloads.
- Protected the Electron backend with a per-launch token and tightened renderer navigation and permissions.
- Preserved existing Local Agent sessions, settings, workspaces, and themes.
