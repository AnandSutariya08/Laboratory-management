@echo off
rem Runs the connector and restarts it if it ever stops. Started by the "HCL Machine Connector" task.
cd /d "%~dp0"
if not exist data mkdir data
:loop
node src\index.js >> data\console.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
