@echo off
rem Gapless Cast demo. Needs Node.js 18+ (winget install OpenJS.NodeJS.LTS).
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8080
node server.js
pause
