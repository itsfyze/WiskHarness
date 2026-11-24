# Build and troubleshoot WiskHarness

## Reproduce the Windows build

Use Windows x64, Node.js 24.19.0 and npm. From the repository root run:

    npm ci
    npm run check
    npm test
    npm run build:win
    npm run finish:release

The lockfile pins npm dependencies. Electron Builder writes the portable executable and per-user NSIS installer under `release/v<version>`. The final release step compiles the uninstall launcher with the WiskHarness icon and writes the three executables' SHA-256 hashes to the manifest. The build tools download Electron and NSIS binaries on first use. Windows builds are unsigned and repeated builds may differ in metadata.

## Runtime setup

Ollama must listen on local port 11434 by default. Check `ollama list` and install a model before doing live inference. Goose can be found on PATH or in `%USERPROFILE%\.local\bin`. Setup and Settings can download the official Windows x64 Goose CLI archive or select an existing local executable. The managed download uses Windows' built-in `tar.exe` to read the one executable from the verified archive. It checks the extracted file before saving it to `goose-runtime` inside the profile. Agent Mode checks the selected Goose version and ACP command. The portable download uses Goose 1.59.2. The built-in Windows PowerShell and CMD are supported. WiskHarness prefers PowerShell 7 for Goose when available.

If the app cannot use its preferred loopback port, it tries nearby ports. If the workspace is inaccessible, choose an existing writable folder. If session storage or vault writes fail, check folder permissions and use a working drive. The app works with Obsidian disabled.

Goose's Windows executable imports the Visual C++ v14 runtime. If the version check cannot start on a clean Windows machine, install the [Microsoft Visual C++ x64 Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist), then retry the Goose check.

For terminal/browser development, run `npm start` and open `http://127.0.0.1:4317` on the same PC. See `.env.example` for isolated development profile settings. Keep real settings files local.

## Releases

The Windows CI workflow tests and builds packages for pull requests and pushes to main. Its artifacts are for CI inspection.

For every GitHub release, review the source diff and run ./desktop/check-release-source.ps1. Stage public source only. Keep credentials, private settings, runtime profiles and personal Obsidian notes out of the commit and release assets. Commit the package and lockfile version changes, push main, then push the matching v<version> tag.

Run **Publish Windows release** from main in GitHub Actions with that tag. The workflow checks the tagged source, tests and builds Setup and Portable, then adds those two EXEs and SHA256SUMS.txt to a draft. It publishes once GitHub reports matching asset sizes and hashes. It then downloads all three public assets without authentication, verifies their SHA-256 hashes and checks the repository version at the tag. Treat a failed verification as an incomplete release.

To publish already verified local builds, run ./desktop/publish-release.ps1 with the pushed tag and the package directory from the clean tagged checkout. Use PowerShell 7 and an authenticated GitHub CLI. This runs the same source, artifact and public download checks. A prerelease tag publishes as a GitHub prerelease.

The standalone launcher opens the native Windows uninstaller for the matching registered WiskHarness version. `--check` checks for a match without launching the uninstaller. For isolated release testing, `--silent` invokes the matching uninstaller in silent mode.

## Verify the beta update

Run npm tests for the ordinary regression suite. The following manual checks require their external runtimes and create disposable profiles.

- Node tests/goose-live.mjs --expiry uses installed Goose ACP with a deterministic, loopback Ollama-compatible fixture. It exercises the Windows shell against a temporary workspace, persistent permission rules and restart, expiry, cancellation, and Obsidian failure and recovery.
- Node tests/goose-live.mjs --web verifies registration against the real Goose process, uses live public websites and GitHub Search, and checks tool removal after disabling access on a previously enabled chat. The same fixture continues through the installed Goose regression tests.
- Node tests/electron-qa.mjs <unpacked-or-installed-exe> installed qa exercises the production renderer using a loopback fixture. It tests Markdown streaming, persistence, clipboard, sanitization, model visibility and the selectors at five CSS sizes across seven themes. An optional fourth argument captures the 2560×1440 performance panel.
- The packaged renderer QA also checks the Plan and Agent home at 2560×1440, 1920×1080, 1440×900 and 1280×720. With a screenshot path, it captures each home variant alongside the performance panel.
- Node tests/electron-qa.mjs <portable-exe> portable live runs the production portable executable against the local Ollama service. The live smoke check expects the documented Llama 3.2 fixture model in the QA script.
- Node tests/electron-qa.mjs <installed-exe> installed live exercises the same smoke check through an installed copy. Run this with a disposable per-user install.
- Node tests/electron-qa.mjs <portable-exe> portable runtime downloads the official Goose release with system discovery disabled, verifies setup and Agent chat, then checks native restoration and saved runtime selection after restart. Use `installed runtime` for the installed copy. The QA mode uses deterministic model responses from a local fixture.

Native display checks report the displays and scaling Windows actually exposes. The five CSS viewport sizes are separate simulated checks.
