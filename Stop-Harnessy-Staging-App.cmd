@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Harnessy-Staging-App.ps1" -Action Stop
if errorlevel 1 (
  echo.
  echo Harnessy staging desktop app did not stop cleanly. Review the error above.
  pause
)
