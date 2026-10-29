@echo off
setlocal
cd /d "%~dp0"
title Lab machine connector - setup
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this PC.
  echo Install "Node.js LTS" from https://nodejs.org, then run setup.bat again.
  pause
  exit /b 1
)
if not exist data mkdir data
if not exist config.json copy config.example.json config.json >nul
echo.
echo Notepad will open config.json.
echo In the lab app open the machine, choose "Connect analyser", copy the settings and paste them
echo over everything in config.json. For more analysers add each one's block to "machines".
echo Save and close Notepad to continue.
echo.
notepad config.json
echo Checking the settings with the lab app...
node src\index.js --check
if errorlevel 1 (
  echo.
  echo Fix config.json and run setup.bat again.
  pause
  exit /b 1
)
call "%~dp0install-startup.bat"
