@echo off
title Bab El Oued Contact online
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org then run this again. & pause & exit /b)
where cloudflared >nul 2>nul || (echo cloudflared is not installed. Open a terminal and run: winget install --id Cloudflare.cloudflared   then run this again. & pause & exit /b)
start "Bab El Oued Contact server" cmd /k node server.js
timeout /t 2 >nul
echo.
echo Your public link appears below, the line ending in trycloudflare.com
echo Open that link yourself too, then create a lobby and send the invite.
echo.
cloudflared tunnel --url http://localhost:8080
pause
