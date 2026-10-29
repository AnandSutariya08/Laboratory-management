@echo off
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
call "%~dp0stop.bat" nopause
schtasks /Delete /TN "HCL Machine Connector" /F >nul 2>&1
netsh advfirewall firewall delete rule name="HCL Machine Connector" >nul 2>&1
echo The connector will no longer start with Windows. You can now delete this folder.
pause
