# WiskHarness

WiskHarness is a self-hosted Windows desktop coding assistant. Agent mode uses Ollama and Goose ACP on your PC. Plan mode also supports LM Studio, compatible loopback endpoints, and four optional cloud APIs. Local operation requires no WiskHarness account.

## Install on Windows

1. Download the portable EXE or per-user Setup EXE from the [v0.7.1 beta release](https://github.com/itsfyze/WiskHarness/releases/tag/v0.7.1).
2. Install [Ollama](https://ollama.com/download/windows), start it, and pull a model of your choice. Agent tool-use quality depends on the model.
3. For Agent mode, install [Goose CLI](https://goose-docs.ai/docs/getting-started/installation/) and put its executable on PATH or in your user profile’s `.local/bin` folder.
4. Open WiskHarness. The setup dialog checks the runtime and lets you choose a workspace, default model, and optional Obsidian vault.

Unsigned builds can trigger Windows reputation checks. Compare the downloaded executable’s SHA-256 hash with the published checksums before opening it.

GitHub displays dots in place of spaces in the executable names. Match each checksum by its Portable, Setup, or Uninstall label.

To remove an installed copy of v0.7.1, use Windows Installed apps or the release’s standalone uninstall launcher. To remove the portable app, delete its executable.

## Local workflows

- **Plan mode** streams text without tools or project memory writes. A Plan chat can be copied into a separate Agent chat. See [provider setup](docs/providers.md) for model selection and cloud consent.
- **Agent mode** uses Goose ACP, with approval prompts for developer tools. The checklist records observed tool events and the latest checkpoint. Preparing a resume fills a new prompt for review.
- **Terminal** runs confirmed PowerShell or CMD commands in the saved workspace. Output and exit status are recorded locally. Stop asks Windows to terminate the process tree.
- **File changes** shows before and after snapshots from the latest captured change set. Revert supports modified text files with a matching after-state. Snapshot coverage is bounded. File creations, deletions, and changes outside the captured workspace have no automatic rollback.
- **Models** shows installed Ollama models, loaded model memory and context when reported, and generation measurements from the latest Plan response.
- **Git** in Projects shows branch, working-tree and staged changes. It can stage or unstage a file and create an unsigned commit after reviewing the staged set.

## Data and updates

Chats and workspaces are saved to a per-user profile. The desktop app recognizes existing Local Agent settings and sessions. Goose native sessions remain in the local profile, with transcript recovery when native restoration is unavailable.

Settings can preview and save a diagnostic report, export a private text-chat and settings backup, and validate a restore before applying it. Backup restores skip chat IDs already present. Enter provider keys again on the destination PC.

A configured Obsidian vault receives background checkpoints for substantial Agent edits. Current status and history include observed files and distinguish Agent-reported results. Obsidian is optional.

Settings can check the official GitHub repository for stable or beta releases. WiskHarness checks the release asset’s HTTPS origin, size and GitHub SHA-256 digest before saving it. Installation and portable replacement are manual. Tailscale detection reports local status. The app’s API remains loopback-only.

## Build from source

On Windows x64, install Node.js 24 and run `npm ci`, `npm run check`, and `npm test`. Use `npm run desktop` to launch from source and `npm run build:win` for the portable and Setup builds. See [build and troubleshooting](docs/build.md), [security](SECURITY.md), and the [changelog](CHANGELOG.md).

WiskHarness source is licensed under MIT. Bundled dependencies and their notices retain their original licenses. See [third-party notices](THIRD-PARTY-NOTICES.md).
