@echo off
rem Auto-start for the desk on this PC, no admin rights needed:
rem   1. a shortcut in the Startup folder starts the supervisor at logon (hidden);
rem   2. a Task Scheduler task runs it every 5 minutes, so a supervisor that stopped comes back by itself;
rem   3. desk processes started by hand are stopped and started again under the supervisor, nothing runs twice.
rem The supervisor (ops\supervise.mjs) restarts the research observer and the dashboard when they stop, and the
rem dashboard restores TEST, or LIVE with exits only. Undo with ops\uninstall-autostart.cmd.
cd /d "%~dp0\.."
set "VBS=%~dp0supervise.vbs"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\solana-desk.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%VBS%\"'; $s.WorkingDirectory='%CD%'; $s.Save()"
schtasks /Create /F /TN "Solana desk watchdog" /SC MINUTE /MO 5 /TR "wscript.exe \"%VBS%\"" >nul
node ops\supervise.mjs --restart
echo Auto-start installed. Status: node ops\supervise.mjs --status   Log: data-desk\supervisor.log
