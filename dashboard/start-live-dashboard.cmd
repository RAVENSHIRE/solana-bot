@echo off
setlocal
cd /d "%~dp0"
set "DASHBOARD_PORT=3002"
set "BOT_STATE_FILE=%~dp0..\data-micro\active-dashboard.json"
set "BOT_TELEMETRY_FILE="
echo Micro dashboard: http://localhost:3002
call npm.cmd start
pause
