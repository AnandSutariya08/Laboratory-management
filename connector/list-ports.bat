@echo off
cd /d "%~dp0"
echo Serial (COM) ports on this PC:
node src\index.js --list-ports
pause
