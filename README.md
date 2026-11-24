# WiskHarness

WiskHarness is a self-hosted Windows desktop coding assistant. Agent mode uses Ollama for local inference and tool calling. Goose ACP is an optional legacy engine. Plan mode also supports LM Studio, compatible loopback endpoints, and four optional cloud APIs. Local operation requires no WiskHarness account.

## Install on Windows

1. Download the portable EXE or per-user Setup EXE from the [WiskHarness releases page](https://github.com/itsfyze/WiskHarness/releases).
2. Install [Ollama](https://ollama.com/download/windows), start it, and pull a model of your choice. Agent tool-use quality depends on the model.
3. Open WiskHarness and choose a workspace, default model, and optional Obsidian vault.
4. For an existing Goose ACP workflow, select Goose in Settings → Agent execution and configure its runtime. The default Ollama engine works without Goose.

Unsigned builds can trigger Windows reputation checks. Compare the downloaded executable’s SHA-256 hash with the published checksums before opening it.

GitHub displays dots in place of spaces in the executable names. Match each checksum by its Portable, Setup, or Uninstall label.

To remove an installed copy, use Windows Installed apps or the matching release’s standalone uninstall launcher. To remove the portable app, delete its executable. WiskHarness stores chats and preferences separately.

## Local workflows

New chats open on the centered WiskHarness home. Switch modes or models from the composer. Prompt suggestions fill an editable draft. In a new Agent chat, the workspace picker lists registered folders. Projects can create a folder and select it for new chats. Existing conversations keep their original workspace. WiskHarness restores your last selected chat at startup.

- **Plan mode** streams text without tools or project memory writes. A Plan chat can be copied into a separate Agent chat. See [provider setup](docs/providers.md) for model selection and cloud consent.
- **Agent mode** uses native Ollama tools when advertised. A model without working native calls can use Ollama's structured JSON output when it advertises completion. The Agent validates either format against the same tool schemas and approval policy. Configure the model-round, tool-call and elapsed-time limits in Settings → Agent execution. Incomplete turns keep their action records. The checklist can fill a resume prompt for review.
- **Approvals** apply to file and shell tools. With workspace restrictions enabled, the native Agent asks before each shell command because an approved Windows process can access files and the network outside its workspace. See [security](SECURITY.md) for legacy Goose behavior.
- **Terminal** runs confirmed PowerShell or CMD commands in the saved workspace. Output and exit status are recorded locally. Stop asks Windows to terminate the process tree.
- **File changes** shows before and after snapshots from the latest captured change set. Revert supports modified text files with a matching after-state. Snapshot coverage is bounded. File creations, deletions, and changes outside the captured workspace have no automatic rollback.
- **Models** updates picker visibility in place. The composer shows the current model and its latest measured speed. Open it for timing, token, context and hardware details. Saved Plan and Agent messages render Markdown with copyable code blocks.
- **Git** in Projects shows branch, working-tree and staged changes. It can stage or unstage a file and create an unsigned commit after reviewing the staged set.

## Data and updates

Agent Mode offers an **Internet access** switch in the composer and under **Settings → Agent internet access**. It starts off and applies to the next Agent turn. The built-in tools can read public text pages and search public GitHub issues and pull requests or Wikipedia. For broader search, supply the public HTTPS search endpoint of a [SearXNG instance with JSON enabled](https://docs.searxng.org/dev/search_api.html). Page retrieval works without a search provider or API key.

Web tools return source URLs and limit requests to public addresses. They do not read local files or inherit browser credentials. Queries go to the selected search service. For legacy Goose ACP, switching Internet access starts a fresh Goose session and recovers context from the saved chat. Shell commands can still use the network under Windows permissions, including in Full access.

Chats and workspaces are saved to a per-user profile. The desktop app recognizes existing Local Agent settings and sessions. Goose native sessions remain in the local profile, with transcript recovery when native restoration is unavailable.

Settings can preview and save a diagnostic report, export a private text-chat and settings backup, and validate a restore before applying it. Backup restores skip chat IDs already present. Enter provider keys again on the destination PC.

A configured Obsidian vault receives background checkpoints for substantial Agent edits and keeps their history. To supply project facts to the Agent, add an “Agent context” level-two heading to the matching project note. Set the first line under it to `Workspace: ` followed by the absolute workspace path, then add the facts below it. A failed write can be inspected or retried from the chat. Configure or disable the integration in Settings.

Settings can check the official GitHub repository for stable or beta releases. WiskHarness checks the release asset’s HTTPS origin, size and GitHub SHA-256 digest before saving it. From beta.6 onward, choose **Update** to download in the background, verify the package, and restart into the new version. Finish or cancel active work if asked. Upgrading from beta.5 or earlier requires running Setup or replacing Portable once. Keep the Portable executable in a writable location. Tailscale detection reports local status. The app’s API remains loopback-only.

## Build from source

On Windows x64, install Node.js 24 and run `npm ci`, `npm run check`, and `npm test`. Use `npm run desktop` to launch from source. Use `npm run build:win` and `npm run finish:release` to make all four release files. See [build and troubleshooting](docs/build.md), [security](SECURITY.md), and the [changelog](CHANGELOG.md).

WiskHarness source is licensed under MIT. Bundled dependencies and their notices retain their original licenses. See [third-party notices](THIRD-PARTY-NOTICES.md).
