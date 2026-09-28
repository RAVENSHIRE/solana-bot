@echo off
setlocal
cd /d "%~dp0"
set "DASHBOARD_PORT=3002"
set "BOT_STATE_FILE=%~dp0..\data-live-test\state-LIVE.json"
set "BOT_TELEMETRY_FILE=%~dp0..\data-live-test\dashboard-LIVE.json"
echo Live dashboard: http://localhost:3002
call npm.cmd start
pause
