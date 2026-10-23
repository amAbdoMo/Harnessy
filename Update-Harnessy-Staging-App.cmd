@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0apps\desktop\scripts\staging-launcher.ps1" -Action Update
set "updateExit=%errorlevel%"
if not "%updateExit%"=="0" (
  echo.
  echo Harnessy staging update failed. The selected runtime is unchanged. Review the output above.
  pause
)
exit /b %updateExit%
