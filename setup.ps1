$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$triple = 'x86_64-pc-windows-msvc'
$dir = Join-Path $PSScriptRoot 'src-tauri\binaries'
New-Item -ItemType Directory -Force $dir | Out-Null
$tmp = Join-Path $env:TEMP 'cobble-setup'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Get-Zip($url, $inner, $dest) {
    $zip = Join-Path $tmp ([IO.Path]::GetFileName($url))
    Invoke-WebRequest $url -OutFile $zip
    $out = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($zip))
    Expand-Archive $zip -DestinationPath $out -Force
    $exe = Get-ChildItem $out -Recurse -Filter $inner | Select-Object -First 1
    Copy-Item $exe.FullName $dest -Force
}

$ytdlp = Join-Path $dir "yt-dlp-$triple.exe"
if (-not (Test-Path $ytdlp)) {
    Write-Host 'Downloading yt-dlp'
    Invoke-WebRequest 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $ytdlp
}

$deno = Join-Path $dir "deno-$triple.exe"
if (-not (Test-Path $deno)) {
    Write-Host 'Downloading deno (yt-dlp needs a JS runtime for YouTube)'
    Get-Zip 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' 'deno.exe' $deno
}

$ffmpeg = Join-Path $dir "ffmpeg-$triple.exe"
if (-not (Test-Path $ffmpeg)) {
    $local = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($local) {
        Write-Host 'Copying ffmpeg from PATH'
        Copy-Item $local.Source $ffmpeg
    } else {
        Write-Host 'Downloading ffmpeg'
        Get-Zip 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' 'ffmpeg.exe' $ffmpeg
    }
}

Write-Host 'Binaries ready'
