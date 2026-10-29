@echo off
rem Use after changing config.json.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
call "%~dp0stop.bat" nopause
schtasks /Run /TN "HCL Machine Connector" >nul
echo Restarted. Status page: http://localhost:7300
timeout /t 4 >nul
start "" http://localhost:7300
