[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$Tag,
    [Parameter(Mandatory)][string]$AssetDirectory,
    [string]$NotesFile
)
$ErrorActionPreference = 'Stop'
$repository = 'itsfyze/WiskHarness'
& "$PSScriptRoot/check-release-source.ps1"
$version = $Tag.Substring(1)
$package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath 'package-lock.json' -Raw | ConvertFrom-Json -AsHashtable
if ($package.version -ne $version -or $lock.version -ne $version -or $lock.packages[''].version -ne $version) {
    throw "Package and lockfile versions must match $Tag."
}
$commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not determine the release commit' }
git diff --quiet HEAD
if ($LASTEXITCODE -ne 0) { throw 'Tracked source must match the release commit' }
$remote = "https://github.com/$repository.git"
$tagRefs = @(git ls-remote --exit-code $remote "refs/tags/$Tag" "refs/tags/$Tag^{}")
if ($LASTEXITCODE -ne 0 -or !$tagRefs.Count) { throw "Push $Tag before publishing." }
$tagCommit = ($tagRefs[-1] -split '\s+')[0]
if ($tagCommit -ne $commit) { throw "Remote $Tag does not point to the checked-out commit." }
git merge-base --is-ancestor $commit refs/remotes/origin/main
if ($LASTEXITCODE -ne 0) { throw 'The tag commit must be present on origin/main.' }

$directory = (Resolve-Path -LiteralPath $AssetDirectory).Path
$names = @("WiskHarness Portable $version.exe", "WiskHarness Setup $version.exe", 'SHA256SUMS.txt', 'update-manifest.json')
$files = @{}
$hashes = @{}
$manifestLines = @()
$updateFiles = @()
foreach ($name in $names[0..1]) {
    $file = Get-Item -LiteralPath (Join-Path $directory $name)
    if ($file.VersionInfo.ProductVersion -ne $version) { throw "Unexpected executable version in $name." }
    $files[$name] = $file
    $hashes[$name] = (Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    $manifestLines += "$($hashes[$name])  $name"
    $updateFiles += [ordered]@{
        kind = if ($name.Contains(' Portable ')) { 'portable' } else { 'setup' }
        name = $name.Replace(' ', '.')
        size = $file.Length
        digest = "sha256:$($hashes[$name])"
    }
}
$updateManifest = Join-Path $directory $names[3]
$metadata = [ordered]@{
    version = $version
    repository = $repository
    channel = if ($version.Contains('-')) { 'beta' } else { 'stable' }
    files = $updateFiles
} | ConvertTo-Json -Depth 4
$metadata | Set-Content -LiteralPath $updateManifest -Encoding utf8
$files[$names[3]] = Get-Item -LiteralPath $updateManifest
$hashes[$names[3]] = (Get-FileHash -LiteralPath $updateManifest).Hash.ToLowerInvariant()
$manifest = Join-Path $directory $names[2]
if (!(Test-Path -LiteralPath $manifest)) { $manifestLines | Set-Content -LiteralPath $manifest -Encoding ascii }
$actualLines = @(Get-Content -LiteralPath $manifest)
if ($actualLines.Count -ne $manifestLines.Count -or @(Compare-Object $actualLines $manifestLines -CaseSensitive).Count) {
    throw 'SHA256SUMS.txt must contain the exact two package names and their SHA-256 hashes.'
}
$files[$names[2]] = Get-Item -LiteralPath $manifest
$hashes[$names[2]] = (Get-FileHash -LiteralPath $manifest).Hash.ToLowerInvariant()

function Read-Release {
    $json = & gh release view $Tag --repo $repository --json tagName,isDraft,url,assets 2>$null
    if ($LASTEXITCODE -eq 0) { return ($json | ConvertFrom-Json) }
    return $null
}
function Published-Name([string]$Name) { return $Name.Replace(' ', '.') }
function Assert-Asset($Asset, [string]$Name) {
    if ($Asset.size -ne $files[$Name].Length -or $Asset.digest -ne "sha256:$($hashes[$Name])") {
        throw "Asset bytes or digest differ for $Name."
    }
}

$release = Read-Release
if (!$release) {
    $options = @('--repo',$repository,'--verify-tag','--draft','--title',"WiskHarness $version")
    if ($version.Contains('-')) { $options += @('--prerelease','--latest=false') }
    if ($NotesFile) { $options += @('--notes-file',(Resolve-Path -LiteralPath $NotesFile).Path) }
    else { $options += '--generate-notes' }
    & gh release create $Tag @options
    if ($LASTEXITCODE -ne 0) { throw 'Could not create GitHub draft release' }
    $release = Read-Release
}
if (!$release -or $release.tagName -ne $Tag) { throw 'Release tag readback failed' }
$allowed = @($names | ForEach-Object { Published-Name $_ })
$expectedAliases = @($names + $allowed)
if (@($release.assets | Where-Object { $_.name -notin $expectedAliases }).Count) { throw 'Unexpected assets are attached to the release.' }
foreach ($name in $names) {
    $existing = @($release.assets | Where-Object { $_.name -in @($name,(Published-Name $name)) })
    if ($existing.Count -gt 1) { throw "Duplicate asset for $name." }
    if ($existing.Count -eq 1) { Assert-Asset $existing[0] $name; continue }
    if (!$release.isDraft) { throw "Published release is missing $name." }
    & gh release upload $Tag --repo $repository $files[$name].FullName
    if ($LASTEXITCODE -ne 0) { throw "Could not upload $name. The release remains a draft." }
}
$release = Read-Release
if (!$release -or $release.assets.Count -ne $names.Count) { throw 'Unexpected number of uploaded assets.' }
foreach ($name in $names) {
    $asset = @($release.assets | Where-Object { $_.name -in @($name,(Published-Name $name)) })
    if ($asset.Count -ne 1) { throw "Asset readback failed for $name." }
    Assert-Asset $asset[0] $name
}
if ($release.isDraft) {
    & gh release edit $Tag --repo $repository --draft=false
    if ($LASTEXITCODE -ne 0) { throw 'Could not publish the verified draft release' }
}

$release = Invoke-RestMethod "https://api.github.com/repos/$repository/releases/tags/$Tag"
if ($release.tag_name -ne $Tag -or $release.draft -or $release.assets.Count -ne $names.Count) { throw 'Public release readback failed' }
$remotePackage = Invoke-RestMethod "https://raw.githubusercontent.com/$repository/$commit/package.json"
if ($remotePackage -is [string]) { $remotePackage = $remotePackage | ConvertFrom-Json }
if ($remotePackage.version -ne $version) { throw 'Published repository version does not match the tag' }
foreach ($name in $names) {
    $asset = @($release.assets | Where-Object { $_.name -in @($name,(Published-Name $name)) })
    if ($asset.Count -ne 1) { throw "Public release is missing $name." }
    Assert-Asset $asset[0] $name
    $download = [IO.Path]::GetTempFileName()
    try {
        curl.exe --fail --silent --show-error --location --retry 2 --max-time 300 --output $download $asset[0].browser_download_url
        if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $download).Hash.ToLowerInvariant() -ne $hashes[$name]) {
            throw "Public download verification failed for $name."
        }
        Write-Host "Downloaded and verified $name"
    } finally { Remove-Item -LiteralPath $download -Force }
}
Write-Host "Verified $Tag at $commit and all public downloads."
Write-Output $release.html_url
