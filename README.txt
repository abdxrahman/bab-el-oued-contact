BAB EL OUED CONTACT, MULTIPLAYER SERVER
=======================================

What you need once: Node.js (the LTS version) from https://nodejs.org
Nothing else to install for LAN play.


1. LAN: friends in the same house or on the same Wi-Fi
------------------------------------------------------
Windows: double click start-lan.bat
Mac or Linux: run ./start-lan.sh

A window opens and shows two addresses:
  On this computer:        http://localhost:8080
  Friends on your network: http://192.168.x.x:8080

You open the first one, your friends open the second one in their browser.
In the game press ONLINE, create a lobby, and send the invite link (it already
uses your network address). Up to 12 players per lobby.

If friends cannot connect: allow Node.js through Windows Firewall when Windows
asks (tick Private networks), and make sure everyone is on the same Wi-Fi.

The first time it runs with internet it saves a copy of the 3D engine in the
vendor folder, so after that LAN games work even without internet.


2. ONLINE, the quick way: play from your PC with friends anywhere
------------------------------------------------------------------
Install cloudflared once (free, by Cloudflare):
  Windows: open a terminal and run   winget install --id Cloudflare.cloudflared
  Mac:     brew install cloudflared

Then double click start-online.bat (or run ./start-online.sh).
After a few seconds it prints a link ending in trycloudflare.com.
Open that link yourself, press ONLINE, create a lobby, send the invite link.
The link changes each time you start it. Your PC has to stay on while you play.


3. ONLINE, always on: put the server on a free host
----------------------------------------------------
GitHub stores the code; it does not run the game server. Use GitHub together
with Render (or another Node.js host) like this:

  1. Create a new GitHub repository. Do not add a README, .gitignore, or
     license if GitHub asks, because this folder already contains the project.
  2. In this folder, open PowerShell and run:

       git init
       git add .
       git commit -m "Initial game server"
       git branch -M main
       git remote add origin https://github.com/YOUR-NAME/YOUR-REPOSITORY.git
       git push -u origin main

     Replace YOUR-NAME/YOUR-REPOSITORY with your GitHub repository address.
  3. Create a free account at https://render.com, choose New > Blueprint,
     and select the GitHub repository. Render reads render.yaml and creates
     the server automatically.
  4. Open the HTTPS address Render gives you:
     https://<name>.onrender.com
     Press ONLINE, create a lobby, and send the invite link to your friends.

  The Render free plan sleeps after 15 minutes with nobody playing and takes
  about half a minute to wake up on the next visit. Render supports the
  game's WebSocket connections, so friends do not need to be on the same
  Wi-Fi.

  To update the online game later:
       git add .
       git commit -m "Update game"
       git push
  Render redeploys after the push.

  Important: a public GitHub repository lets other people see the source and
  game assets. Never put passwords, API keys, or other secrets in this folder.

Any other host that runs Node.js or Docker works too (Railway, Fly.io, a VPS).
It listens on the PORT the host gives it. If links come out wrong, set
PUBLIC_URL to your address, for example PUBLIC_URL=https://mygame.example.com


Updating the game
-----------------
When there is a new version of the game, replace index.html in this folder with
the new one and restart the server.

Settings (optional, as environment variables)
  PORT          port to listen on, default 8080
  PUBLIC_URL    the address used in invite links
  MAX_PLAYERS   players per lobby, default 12

Note: hits are decided by the shooter's own game, which is smooth on LAN and
fine with friends, but it is not protected against cheaters on a public server.

MATCH RULES AND CHAT
Whoever creates the lobby is the host and picks the time limit and kills to win
in the lobby screen. When the time runs out or someone reaches the kill target,
the match ends, the scoreboard shows the winner, and a new round starts after
12 seconds. Press Enter (or Y) in a match to chat with everyone.
