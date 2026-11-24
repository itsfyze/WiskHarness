$ErrorActionPreference = 'Stop'
$paths = @(git ls-files)
if ($LASTEXITCODE -ne 0 -or !$paths.Count) { throw 'Run the release check from the repository root' }
$privatePath = '(?i)(^|/)(?:local-data|runtime-staging|node_modules|release|updates|backups|\.obsidian|\.ssh|\.aws|\.config|Obsidian|AI Notes|Personal Notes|ui-audit)(?:/|$)|(?:^|/)(?:settings(?!\.example\.json$)[^/]*\.json|\.env(?!\.example$)[^/]*|\.npmrc|credentials?[^/]*\.json|RELEASE-PROGRESS\.md|WiskHarness profile\.json)$|\.(?:exe|zip|dmp|log|pem|key|pfx|dpapi|sqlite|db)$'
$unexpected = @($paths | Where-Object { $_ -match $privatePath })
if ($unexpected.Count) { throw ('Private or generated paths in the release tree: ' + ($unexpected -join ', ')) }

$secretPattern = '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|(AKIA|ASIA)[A-Z0-9]{16}|sk-(proj-|ant-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35}'
$matches = @(git grep --cached -I -l -E -e $secretPattern)
if ($LASTEXITCODE -eq 0) { throw ('Possible credentials in the release tree: ' + ($matches -join ', ')) }
if ($LASTEXITCODE -ne 1) { throw 'Could not scan staged source for credentials' }
Write-Host "Checked $($paths.Count) tracked paths for private files and recognizable credentials."
