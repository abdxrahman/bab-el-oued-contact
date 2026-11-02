@echo off
title Bab El Oued Contact server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org then run this again. & pause & exit /b)
node server.js
pause
