# WiskHarness

WiskHarness is a self-hosted Windows desktop coding assistant. Agent mode uses Ollama and Goose ACP on your PC. Plan mode also supports LM Studio, compatible loopback endpoints, and four optional cloud APIs. Local operation requires no WiskHarness account.

## Install on Windows

1. Download the portable EXE or per-user Setup EXE from the [WiskHarness releases page](https://github.com/itsfyze/WiskHarness/releases).
2. Install [Ollama](https://ollama.com/download/windows), start it, and pull a model of your choice. Agent tool-use quality depends on the model.
3. Open WiskHarness and choose a workspace, default model, and optional Obsidian vault.
4. For Agent Mode, choose a Goose runtime in setup or Settings. Automatic checks installed Goose first. You can download portable Goose into the app profile or choose an existing local executable. Plan Mode does not require Goose.

Unsigned builds can trigger Windows reputation checks. Compare the downloaded executable’s SHA-256 hash with the published checksums before opening it.

GitHub displays dots in place of spaces in the executable names. Match each checksum by its Portable, Setup, or Uninstall label.

To remove an installed copy, use Windows Installed apps or the matching release’s standalone uninstall launcher. To remove the portable app, delete its executable. WiskHarness stores chats and preferences separately.

## Local workflows

- **Plan mode** streams text without tools or project memory writes. A Plan chat can be copied into a separate Agent chat. See [provider setup](docs/providers.md) for model selection and cloud consent.
- **Agent mode** uses Goose ACP. Ask mode requests approval for restricted tools; Approve for me approves only eligible safe reads; opt-in Full access automatically approves Goose tool requests, including PowerShell/CMD shell commands, unless an explicit deny or inspectable protected-path policy blocks the request. Goose runs with the Windows user's privileges. No process or network sandbox exists; shell commands can affect files outside the selected workspace and protections cannot inspect their side effects. Plan mode always remains tool-free. The checklist records observed tool events and the latest checkpoint. Preparing a resume fills a new prompt for review.
- **Terminal** runs confirmed PowerShell or CMD commands in the saved workspace. Output and exit status are recorded locally. Stop asks Windows to terminate the process tree.
- **File changes** shows before and after snapshots from the latest captured change set. Revert supports modified text files with a matching after-state. Snapshot coverage is bounded. File creations, deletions, and changes outside the captured workspace have no automatic rollback.
- **Models** updates picker visibility in place. The composer shows the current model and its latest measured speed. Open it for timing, token, context and hardware details. Saved Plan and Agent messages render Markdown with copyable code blocks.
- **Git** in Projects shows branch, working-tree and staged changes. It can stage or unstage a file and create an unsigned commit after reviewing the staged set.

## Data and updates

Chats and workspaces are saved to a per-user profile. The desktop app recognizes existing Local Agent settings and sessions. Goose native sessions remain in the local profile, with transcript recovery when native restoration is unavailable.

Settings can preview and save a diagnostic report, export a private text-chat and settings backup, and validate a restore before applying it. Backup restores skip chat IDs already present. Enter provider keys again on the destination PC.

A configured Obsidian vault receives background checkpoints for substantial Agent edits. The project note updates its current fields and keeps checkpoint history. A failed write can be inspected or retried from the chat. Configure or disable the integration in Settings.

Settings can check the official GitHub repository for stable or beta releases. WiskHarness checks the release asset’s HTTPS origin, size and GitHub SHA-256 digest before saving it. Installation and portable replacement are manual. Tailscale detection reports local status. The app’s API remains loopback-only.

## Build from source

On Windows x64, install Node.js 24 and run `npm ci`, `npm run check`, and `npm test`. Use `npm run desktop` to launch from source. Use `npm run build:win` and `npm run finish:release` to make all four release files. See [build and troubleshooting](docs/build.md), [security](SECURITY.md), and the [changelog](CHANGELOG.md).

WiskHarness source is licensed under MIT. Bundled dependencies and their notices retain their original licenses. See [third-party notices](THIRD-PARTY-NOTICES.md).
