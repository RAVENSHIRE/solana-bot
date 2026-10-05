@echo off
rem Starts the dashboard minimized with its output in data-desk\dashboard.log.
rem A console window that is clicked or has text selected pauses every program writing to it (Windows QuickEdit);
rem with the output in a file, the desk can never freeze that way.
cd /d "%~dp0"
rem With auto-start installed (ops\install-autostart.cmd) the supervisor runs it: starting it here too would run it twice.
if exist ..\data-desk\supervisor.lock (echo The supervisor runs the dashboard. Restart with: node ops\supervise.mjs --restart & exit /b 0)
start "solana-desk" /min cmd /c "npm start >> ..\data-desk\dashboard.log 2>&1"
echo Dashboard starting on http://localhost:3000  (log: data-desk\dashboard.log)
