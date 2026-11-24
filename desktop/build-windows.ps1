param([switch]$PortableOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid Windows build version' }
$output = Join-Path $root "release/v$version"
$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName
$shortPath = Join-Path $tempRoot ('wh-package-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$builder = Join-Path $root 'node_modules/.bin/electron-builder.cmd'

Push-Location $root
try {
    & npm.cmd run stage:runtime
    if ($LASTEXITCODE) { throw 'Could not stage the Windows runtime' }
    $target = if ($PortableOnly) { 'dir' } else { 'nsis' }
    & $builder --win $target --x64 --publish never
    if ($LASTEXITCODE) { throw 'Could not build the Windows application payload' }

    # Direct extraction from a short staging path avoids the portable copy phase
    # and keeps cold startup within the restart window of existing beta updaters.
    New-Item -ItemType Directory -Path $shortPath | Out-Null
    & robocopy.exe (Join-Path $output 'win-unpacked') $shortPath /E /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) { throw 'Could not stage the Portable payload' }
    & $builder --win portable --x64 --prepackaged $shortPath --publish never "-c.directories.output=$output" '-c.portable.useZip=true' '-c.compression=store'
    if ($LASTEXITCODE) { throw 'Could not build WiskHarness Portable' }
    $portable = Get-Item -LiteralPath (Join-Path $output "WiskHarness Portable $version.exe")
    if ($portable.Length -gt (512MB)) { throw 'The Portable package exceeds the updater download limit' }
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $shortPath) {
        $item = Get-Item -LiteralPath $shortPath -Force
        if ($item.FullName -eq [IO.Path]::GetFullPath($shortPath) -and $item.Parent.FullName -eq $tempRoot -and
            -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
    }
}
