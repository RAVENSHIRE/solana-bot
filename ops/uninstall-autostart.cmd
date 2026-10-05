@echo off
rem Removes the desk's auto-start (Startup shortcut and watchdog task) and stops the supervisor and the desk processes.
cd /d "%~dp0\.."
powershell -NoProfile -Command "Remove-Item -ErrorAction SilentlyContinue ([Environment]::GetFolderPath('Startup')+'\solana-desk.lnk')"
schtasks /Delete /F /TN "Solana desk watchdog" >nul 2>&1
node ops\supervise.mjs --stop
echo Auto-start removed. Start by hand with dashboard\start-background.cmd and dashboard\start-research.cmd.
