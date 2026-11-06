@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0site\serve-local.ps1"
if errorlevel 1 pause
