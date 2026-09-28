@echo off
setlocal
cd /d "%~dp0"
if defined PLAYBOOK_STATE_DIR (
  echo For a custom PLAYBOOK_STATE_DIR set BOT_STATE_FILE and BOT_TELEMETRY_FILE explicitly.
  if not defined BOT_STATE_FILE goto fail
  if not defined BOT_TELEMETRY_FILE goto fail
) else (
  set "BOT_STATE_FILE=%~dp0..\data-playbook\state-SIMULATION.json"
  set "BOT_TELEMETRY_FILE=%~dp0..\data-playbook\dashboard-SIMULATION.json"
)
set "DASHBOARD_PORT=3001"
call start-dashboard.cmd
exit /b %errorlevel%
:fail
pause
exit /b 1
