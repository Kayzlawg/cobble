@echo off
cd /d "%~dp0"
if not exist src-tauri\binaries\yt-dlp-x86_64-pc-windows-msvc.exe powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
if not exist node_modules call npm install
call npm run tauri dev
