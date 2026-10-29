@echo off
setlocal
cd /d "%~dp0"
title Lab machine connector - install
rem Needs administrator rights: ask for them if we do not have them.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
for /f "delims=" %%n in ('where node') do set NODE_EXE=%%n& goto :found
:found
rem Let analysers on the network connect to the connector (only used by "tcp-server" links).
netsh advfirewall firewall delete rule name="HCL Machine Connector" >nul 2>&1
netsh advfirewall firewall add rule name="HCL Machine Connector" dir=in action=allow program="%NODE_EXE%" enable=yes profile=private,domain >nul
rem Start with Windows (even before anyone signs in), and start now.
schtasks /End /TN "HCL Machine Connector" >nul 2>&1
schtasks /Create /TN "HCL Machine Connector" /TR "\"%~dp0start.bat\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F >nul
if errorlevel 1 (
  echo Could not create the startup task.
  pause
  exit /b 1
)
schtasks /Run /TN "HCL Machine Connector" >nul
echo.
echo The connector is running and will start by itself whenever this PC starts.
echo Its status page is http://localhost:7300 (opening it now).
timeout /t 4 >nul
start "" http://localhost:7300
pause
