@echo off
rem Double-click to rebuild the project list after adding / removing folders in projects\
rem Uses PowerShell 7 (pwsh) when installed, otherwise the built-in Windows PowerShell.
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
)
pause
