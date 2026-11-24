# WiskHarness

WiskHarness is a Windows desktop coding assistant. Agent mode runs Mistral Vibe with your Ollama models. Native Ollama and Goose remain available in Settings. Local inference requires no WiskHarness or Mistral account.

## Install on Windows

1. Download the portable EXE or per-user Setup EXE from the [WiskHarness releases page](https://github.com/itsfyze/WiskHarness/releases).
2. Install [Ollama](https://ollama.com/download/windows), start it, and pull a model of your choice. Agent tool-use quality depends on the model.
3. Open WiskHarness and choose a workspace, default model, and optional Obsidian vault.
4. For an existing Goose ACP workflow, select Goose in Settings → Agent execution and configure its runtime. Vibe is bundled in both Windows packages.

Unsigned builds can trigger Windows reputation checks. Compare the downloaded executable’s SHA-256 hash with the published checksums before opening it.

GitHub displays dots in place of spaces in the executable names. Match each checksum by its Portable or Setup label.

To remove an installed copy, use Windows Installed apps. To remove the portable app, delete its executable. WiskHarness stores chats and preferences separately.

## Local workflows

New chats open on the centered WiskHarness home. Switch modes or models from the composer. Prompt suggestions fill an editable draft. In a new Agent chat, the workspace picker lists registered folders. Projects can create a folder and select it for new chats. Existing conversations keep their original workspace. WiskHarness restores your last selected chat at startup.

- **Agent** edits files, runs commands and verifies requested outcomes. Vibe runs the model and keeps native session state. WiskHarness supplies the tools and enforces approvals. The native Ollama engine provides structured JSON compatibility for models that struggle with tool calls.
- **Plan** can inspect the selected workspace through read-only Vibe tools with a compatible Ollama model. Remote chat providers and other Plan models receive conversation text. **Ask** always uses conversation text without workspace tools. See [provider setup](docs/providers.md).
- **Approvals** apply to file, shell and external MCP tools. Full Access allows routine workspace commands. WiskHarness still asks before protected actions and dependency installs. Approved shell commands run with the current Windows account. See [security](SECURITY.md).
- **Terminal** runs confirmed PowerShell or CMD commands in the saved workspace. Output and exit status are recorded locally. Stop asks Windows to terminate the process tree.
- **Changes** shows live workspace snapshots, unified or side-by-side diffs, and bounded text and binary metadata. WiskHarness verifies the after-state before reverting a directly attributed text edit or creation. Use Files to open or reveal a file from the selected workspace.
- **Models** shows local model availability and Vibe options. The composer shows the model, provider, runtime, live speed estimate, and the last speed measured by Ollama. Open it for token, context and hardware details.
- **Git** in Projects shows branch, working-tree and staged changes. It can stage or unstage a file and create an unsigned commit after reviewing the staged set.

## Data and updates

Agent Mode offers an **Internet access** switch in the composer and under **Settings → Agent internet access**. It starts off and applies to the next Agent turn. The built-in tools can read public text pages and search public GitHub issues and pull requests or Wikipedia. For broader search, choose Brave Search and supply an API key, or configure a [SearXNG endpoint with JSON enabled](https://docs.searxng.org/dev/search_api.html) on public HTTPS or your own loopback server. Page retrieval works without a search provider.

Web tools return source URLs and limit requests to public addresses. Page retrieval blocks private hosts. Queries go to the service you configure. Manage approved external tools from MCP in the sidebar. Windows encrypts saved MCP and search credentials for the current user. For legacy Goose ACP, switching Internet access starts a fresh Goose session and recovers context from the saved chat. Shell commands can still use the network under Windows permissions, including in Full access.

Chats and workspaces are saved to a per-user profile. The desktop app recognizes existing Local Agent settings and sessions. Vibe and Goose keep their own session state inside the profile. When native restoration is unavailable, WiskHarness can recover context from that chat’s saved transcript.

Settings can preview and save a diagnostic report, export a private text-chat and settings backup, and validate a restore before applying it. Backup restores skip chat IDs already present. Enter provider keys again on the destination PC.

A configured Obsidian vault receives background checkpoints for substantial Agent edits and keeps their history. To supply project facts to the Agent, add an “Agent context” level-two heading to the matching project note. Set the first line under it to `Workspace: ` followed by the absolute workspace path, then add the facts below it. A failed write can be inspected or retried from the chat. Configure or disable the integration in Settings.

Settings can check the official GitHub repository for stable or beta releases. WiskHarness checks the release asset’s HTTPS origin, size and GitHub SHA-256 digest before saving it. From beta.6 onward, choose **Update** to download in the background, verify the package, and restart into the new version. Finish or cancel active work if asked. Upgrading from beta.5 or earlier requires running Setup or replacing Portable once. Keep the Portable executable in a writable location. Tailscale detection reports local status. The app’s API remains loopback-only.

## Build from source

On Windows x64, install Node.js 24 and run `npm ci`, `npm run check`, and `npm test`. Use `npm run desktop` to launch from source. Use `npm run build:win` to generate the Windows executables. The release workflow generates their SHA-256 checksums and update metadata. See [build and troubleshooting](docs/build.md), [security](SECURITY.md), and the [changelog](CHANGELOG.md).

WiskHarness source is licensed under MIT. Bundled dependencies and their notices retain their original licenses. See [third-party notices](THIRD-PARTY-NOTICES.md).
