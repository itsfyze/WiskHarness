param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$version = '3.1.5'
$digest = 'da5a3804fc8c728fda620ea3c9f363324f844a3d9234551699db1081dd4ce7e1'
$archiveName = "vibe-acp-windows-x86_64-$version.zip"
$stage = (Get-Item -LiteralPath $Destination).FullName
$archive = Join-Path $stage $archiveName
function Get-VibeDigest([string]$File) {
    $stream=[IO.File]::OpenRead($File)
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-","").ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$verified = (Test-Path -LiteralPath $archive -PathType Leaf) -and ((Get-VibeDigest $archive) -eq $digest)
if (-not $verified) {
    $partial = Join-Path $stage ("vibe-" + [guid]::NewGuid() + ".partial")
    try {
        & curl.exe --fail --silent --show-error --location --max-redirs 5 --connect-timeout 20 --max-time 240 --proto '=https' --proto-redir '=https' "https://github.com/mistralai/mistral-vibe/releases/download/v$version/$archiveName" --output $partial
        if ($LASTEXITCODE -or (Get-VibeDigest $partial) -ne $digest) {
            throw 'Official Mistral Vibe archive failed integrity verification'
        }
        Move-Item -LiteralPath $partial -Destination $archive -Force
    } finally {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}

$target = Join-Path $stage 'vibe'
$temp = Join-Path $stage ("vibe-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    & tar.exe -xf $archive -C $temp
    if ($LASTEXITCODE -or -not (Test-Path -LiteralPath (Join-Path $temp 'vibe-acp.exe') -PathType Leaf)) {
        throw 'The verified Vibe archive could not be unpacked'
    }
    $reported = & (Join-Path $temp 'vibe-acp.exe') --version
    if ($LASTEXITCODE -or $reported -notmatch [regex]::Escape($version)) { throw 'Vibe failed its version probe' }
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if ($item.FullName -ne [IO.Path]::GetFullPath($target) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Unexpected Vibe staging directory'
        }
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
    Move-Item -LiteralPath $temp -Destination $target
    Write-Host "Staged $reported from the verified official archive."
} finally {
    if (Test-Path -LiteralPath $temp) {
        $item = Get-Item -LiteralPath $temp -Force
        if ($item.FullName -eq [IO.Path]::GetFullPath($temp) -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        }
    }
}
