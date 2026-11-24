[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$Tag,
    [Parameter(Mandatory)][string]$AssetDirectory
)
$ErrorActionPreference = 'Stop'
$repository = 'itsfyze/WiskHarness'
$version = $Tag.Substring(1)
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
$manifestLines | Set-Content -LiteralPath $manifest -Encoding ascii
$actualLines = @(Get-Content -LiteralPath $manifest)
if ($actualLines.Count -ne $manifestLines.Count -or @(Compare-Object $actualLines $manifestLines -CaseSensitive).Count) {
    throw 'SHA256SUMS.txt must contain the exact two package names and their SHA-256 hashes.'
}
$files[$names[2]] = Get-Item -LiteralPath $manifest
$hashes[$names[2]] = (Get-FileHash -LiteralPath $manifest).Hash.ToLowerInvariant()

[pscustomobject]@{ Names = $names; Files = $files; Hashes = $hashes }