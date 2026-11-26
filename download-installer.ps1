# Tacot Edit 0.2.3 installer, downloaded in parts and rebuilt.
# Right-click this file and choose "Run with PowerShell", or run:
#   powershell -ExecutionPolicy Bypass -File .\download-installer.ps1

$ErrorActionPreference = 'Stop'

$base = 'https://github.com/White520-screw-it/Tacot-Edit/releases/download/v0.2.3'
$suffixes = @('aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah')
$expected = 164448722
$out = Join-Path $env:TEMP 'Tacot-Edit-Setup-0.2.3.exe'

foreach ($suffix in $suffixes) {
    $part = "$out.part-$suffix"
    $url = "$base/Tacot-Edit-Setup-0.2.3.exe.part-$suffix"
    Write-Host "Downloading part-$suffix"
    Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing
}

if (Test-Path $out) { Remove-Item -Force $out }
foreach ($suffix in $suffixes) {
    $part = "$out.part-$suffix"
    cmd /c copy /b "$out"+"$part" "$out.joined" | Out-Null
    Move-Item -Force "$out.joined" $out
    Remove-Item -Force $part
}

$size = (Get-Item $out).Length
Write-Host "Installer rebuilt: $out ($size bytes)"
if ($size -ne $expected) {
    Write-Warning "Expected $expected bytes, got $size. Delete the file and download again."
    exit 1
}

Start-Process -FilePath $out
