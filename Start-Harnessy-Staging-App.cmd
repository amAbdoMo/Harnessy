@echo off
if /I "%~1"=="--build-only" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Harnessy-Staging-App.ps1" -Action Build
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Harnessy-Staging-App.ps1" -Action Start %*
)
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" (
  echo.
  echo Harnessy staging build or launch failed. Review the error above.
  pause
)
exit /b %launcherExit%
