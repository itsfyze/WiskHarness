$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root "runtime-staging"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item (Join-Path $root "package.json") (Join-Path $stage "package.json") -Force
Copy-Item (Join-Path $root "package-lock.json") (Join-Path $stage "package-lock.json") -Force
Copy-Item (Join-Path $root "server.mjs") (Join-Path $stage "server.mjs") -Force
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
if (Test-Path (Join-Path $stage "public")) { Remove-Item (Join-Path $stage "public") -Recurse -Force }
Copy-Item (Join-Path $root "public") (Join-Path $stage "public") -Recurse -Force
Write-Host "Installing only production dependencies into staged runtime..."
Push-Location $stage
try { & npm.cmd ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed" } }
finally { Pop-Location }
Write-Host "Runtime staged at $stage"
