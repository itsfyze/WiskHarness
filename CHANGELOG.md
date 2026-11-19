# Changelog

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
