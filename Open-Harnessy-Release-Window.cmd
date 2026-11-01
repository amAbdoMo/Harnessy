@echo off
start "" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0apps\desktop\scripts\release-window.ps1"
exit /b %errorlevel%
