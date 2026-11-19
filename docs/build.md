# Build and troubleshoot WiskHarness

## Reproduce the Windows build

Use Windows x64, Node.js 24.19.0 and npm. From the repository root run:

    npm ci
    npm run check
    npm test
    npm run build:win

The lockfile pins npm dependencies. Electron Builder writes the portable executable and per-user NSIS installer under `release/v0.7.1`. Generate SHA-256 hashes with PowerShell `Get-FileHash`. The build tools download Electron and NSIS binaries on first use. Windows builds are unsigned and repeated builds may differ in metadata.

## Runtime setup

Ollama must listen on local port 11434 by default. Check `ollama list` and install a model before doing live inference. Goose can be found on PATH or in `%USERPROFILE%\.local\bin`. Check `goose --version` and run the in-app dependency checks if ACP is unavailable. The built-in Windows PowerShell and CMD are supported. WiskHarness prefers PowerShell 7 for Goose when available.

If the app cannot use its preferred loopback port, it tries nearby ports. If the workspace is inaccessible, choose an existing writable folder. If session storage or vault writes fail, check folder permissions and use a working drive. The app works with Obsidian disabled.

For terminal/browser development, run `npm start` and open `http://127.0.0.1:4317` on the same PC. See `.env.example` for isolated development profile settings. Keep real settings files local.

## Releases

The Windows workflow runs tests and builds the portable and setup executables on pull requests and pushes to main. Its outputs are CI artifacts. GitHub releases use the verified Windows packages and their checksums in a separate release step.

The standalone uninstaller launcher is built separately. From the repository root in PowerShell, run:

    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $source = (Resolve-Path 'desktop/uninstall-launcher.cs').Path
    $icon = (Resolve-Path 'desktop/assets/wiskharness.ico').Path
    & $csc /nologo /target:winexe /platform:x64 /optimize+ '/out:WiskHarness Uninstall 0.7.1.exe' "/win32icon:$icon" /reference:System.Windows.Forms.dll $source

The launcher opens the native uninstaller registered by Setup for v0.7.1.
