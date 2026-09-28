@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Solana Bot Dashboard

rem Always use this launcher's directory, regardless of where it was started.
pushd "%~dp0"
if errorlevel 1 goto location_error

where node >nul 2>&1
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_node

rem Never let npm fall back to the parent trading-engine package.
if not exist "package.json" goto wrong_package
node -e "const p=require('./package.json'); process.exit(p.name==='solana-bot-dashboard' ? 0 : 1)"
if errorlevel 1 goto wrong_package

echo Installing dashboard dependencies...
call npm.cmd ci --include=dev
if errorlevel 1 goto failed

echo Building the dashboard...
call npm.cmd run build
if errorlevel 1 goto failed

echo Starting the dashboard. Keep this window open.
echo Open the Dashboard URL printed below in your browser.
call npm.cmd start
if errorlevel 1 goto failed
popd
exit /b 0

:missing_node
echo Node.js and npm must be installed and available on PATH.
echo Required Node version: 20.19+ or 22.12+.
goto failed

:wrong_package
echo The dashboard package is missing or has the wrong name.
echo Restore the dashboard package from Git, then open dashboard\start-dashboard.cmd.
goto failed

:location_error
echo Could not open the directory containing this launcher.
pause
exit /b 1

:failed
echo.
echo The dashboard stopped because the step above failed.
echo Keep the error text so it can be diagnosed.
pause
popd
exit /b 1
