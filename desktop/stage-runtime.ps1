$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root "runtime-staging"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$stageItem = Get-Item -LiteralPath $stage -Force
if ($stageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime staging cannot be a reparse point" }
Copy-Item (Join-Path $root "package.json") (Join-Path $stage "package.json") -Force
Copy-Item (Join-Path $root "package-lock.json") (Join-Path $stage "package-lock.json") -Force
Copy-Item (Join-Path $root "THIRD-PARTY-NOTICES.md") (Join-Path $stage "THIRD-PARTY-NOTICES.md") -Force
Copy-Item (Join-Path $root "server.mjs") (Join-Path $stage "server.mjs") -Force
Copy-Item (Join-Path $root "agent-ollama.mjs") (Join-Path $stage "agent-ollama.mjs") -Force
Copy-Item (Join-Path $root "agent-tools.mjs") (Join-Path $stage "agent-tools.mjs") -Force
foreach ($file in @('vibe-runtime.mjs', 'vibe-ollama.mjs', 'agent-vibe-mcp.mjs', 'mcp-manager.mjs')) {
    Copy-Item (Join-Path $root $file) (Join-Path $stage $file) -Force
}
& (Join-Path $PSScriptRoot "stage-vibe.ps1") -Destination $stage
Copy-Item (Join-Path $root "goose-runtime.mjs") (Join-Path $stage "goose-runtime.mjs") -Force
Copy-Item (Join-Path $root "agent-web.mjs") (Join-Path $stage "agent-web.mjs") -Force
Copy-Item (Join-Path $root "agent-web-mcp.mjs") (Join-Path $stage "agent-web-mcp.mjs") -Force
Copy-Item (Join-Path $root "security-policy.mjs") (Join-Path $stage "security-policy.mjs") -Force
Copy-Item (Join-Path $root "providers.mjs") (Join-Path $stage "providers.mjs") -Force
Copy-Item (Join-Path $root "git-workspace.mjs") (Join-Path $stage "git-workspace.mjs") -Force
Copy-Item (Join-Path $root "profile-backup.mjs") (Join-Path $stage "profile-backup.mjs") -Force
Copy-Item (Join-Path $root "workspace-review.mjs") (Join-Path $stage "workspace-review.mjs") -Force
Copy-Item (Join-Path $root "terminal.mjs") (Join-Path $stage "terminal.mjs") -Force
Copy-Item (Join-Path $root "updates.mjs") (Join-Path $stage "updates.mjs") -Force
Copy-Item (Join-Path $root "plan-chat.mjs") (Join-Path $stage "plan-chat.mjs") -Force
Copy-Item (Join-Path $root "session-store.mjs") (Join-Path $stage "session-store.mjs") -Force
Copy-Item (Join-Path $root "obsidian-checkpoint.mjs") (Join-Path $stage "obsidian-checkpoint.mjs") -Force
$stagedPublic = Join-Path $stage "public"
if (Test-Path -LiteralPath $stagedPublic) {
    $directory = Get-Item -LiteralPath $stagedPublic -Force
    if ($directory.FullName -ne [IO.Path]::GetFullPath($stagedPublic) -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing to replace an unexpected runtime public directory"
    }
    Remove-Item -LiteralPath $directory.FullName -Recurse -Force
}
Copy-Item (Join-Path $root "public") (Join-Path $stage "public") -Recurse -Force
Write-Host "Installing only production dependencies into staged runtime..."
Push-Location $stage
try { & npm.cmd ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed" } }
finally { Pop-Location }
Write-Host "Runtime staged at $stage"

$csc = Join-Path $env:WINDIR "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
$runner = Join-Path $stage "WiskHarness Update.exe"
& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$runner" /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot "update-runner.cs")
if ($LASTEXITCODE -ne 0) { throw "Update runner compilation failed" }
