@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
set "CUSTOM_HARNESS_DATA_DIR=%LOCALAPPDATA%\CustomHarness"
if not defined LOCALAPPDATA set "CUSTOM_HARNESS_DATA_DIR=%APPDATA%\CustomHarness"
set "DSH_HOME=%CUSTOM_HARNESS_DATA_DIR%\Harness"
set "DSH_AGENTS_HOME=%CUSTOM_HARNESS_DATA_DIR%\Agents"
set "CUSTOM_HARNESS_AGENTS_DIR=%DSH_AGENTS_HOME%"
set "CUSTOM_HARNESS_LOG_DIR=%CUSTOM_HARNESS_DATA_DIR%\Logs"
set "CUSTOM_HARNESS_CACHE_DIR=%CUSTOM_HARNESS_DATA_DIR%\Cache"
"%~dp0..\..\..\..\Harnessy.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
