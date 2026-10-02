@echo off
rem Starts the research observer minimized with its output in data-desk\research\observer.log (read-only: no trading).
cd /d "%~dp0\.."
if not exist data-desk\research mkdir data-desk\research
start "solana-research" /min cmd /c "npm run research:observe >> data-desk\research\observer.log 2>&1"
echo Research observer starting  (log: data-desk\research\observer.log)
