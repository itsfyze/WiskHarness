$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$') { throw "Unsupported Windows release version" }
$revision = if ($Matches[4]) { $Matches[4] } else { "0" }
$fileVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3]).$revision"
$output = Join-Path $root "release/v$version"
$names = @("WiskHarness Portable $version.exe", "WiskHarness Setup $version.exe", "WiskHarness Uninstall $version.exe")
foreach ($name in $names[0..1]) {
    if (-not (Test-Path -LiteralPath (Join-Path $output $name) -PathType Leaf)) { throw "Build $name first" }
}
$icon = Join-Path $PSScriptRoot "assets/wiskharness.ico"
$source = Join-Path $PSScriptRoot "uninstall-launcher.cs"
$csc = Join-Path $env:WINDIR "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
$metadata = Join-Path $output ([Guid]::NewGuid().ToString() + ".cs")
$launcher = Join-Path $output $names[2]
try {
    @"
[assembly: System.Reflection.AssemblyFileVersion("$fileVersion")]
[assembly: System.Reflection.AssemblyVersion("$fileVersion")]
[assembly: System.Reflection.AssemblyInformationalVersion("$version")]
internal static class ReleaseVersion { public const string Label = "$version"; }
"@ | Set-Content -LiteralPath $metadata -Encoding Ascii
    & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$launcher" "/win32icon:$icon" /reference:System.Windows.Forms.dll $source $metadata
    if ($LASTEXITCODE -ne 0) { throw "Uninstaller compilation failed" }
}
finally {
    if (Test-Path -LiteralPath $metadata -PathType Leaf) { Remove-Item -LiteralPath $metadata }
}
$names | ForEach-Object {
    $stream = [IO.File]::OpenRead((Join-Path $output $_))
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
    "$hash  $_"
} | Set-Content -LiteralPath (Join-Path $output "SHA256SUMS-$version.txt") -Encoding Ascii
