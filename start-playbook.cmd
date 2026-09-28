@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  call npm ci
  if errorlevel 1 goto fail
)
call npm run build:playbook
if errorlevel 1 goto fail
call npm run sim:playbook
if errorlevel 1 goto fail
exit /b 0
:fail
echo Playbook stopped. Review the error above.
pause
exit /b 1
