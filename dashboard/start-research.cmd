@echo off
rem Starts the research observer minimized with its output in data-desk\research\observer.log (read-only: no trading).
cd /d "%~dp0\.."
rem With auto-start installed (ops\install-autostart.cmd) the supervisor runs it: starting it here too would run it twice.
if exist data-desk\supervisor.lock (echo The supervisor runs the research observer. Restart with: node ops\supervise.mjs --restart & exit /b 0)
if not exist data-desk\research mkdir data-desk\research
start "solana-research" /min cmd /c "npm run research:observe >> data-desk\research\observer.log 2>&1"
echo Research observer starting  (log: data-desk\research\observer.log)
