@echo off
rem PartPilot - double-click to install (first run) and start on http://localhost:8000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-windows.ps1" %*
if errorlevel 1 pause
