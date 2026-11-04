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
---------------------------------------------------
Render (render.com, free plan):
  1. Put this whole folder in a GitHub repository.
  2. On Render choose New, Blueprint, pick the repository. render.yaml sets
     everything up.
  3. Your game lives at https://<name>.onrender.com and anyone can join.
  On the free plan the server sleeps after 15 minutes with nobody playing and
  takes about half a minute to wake up on the next visit.

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

TEAM DEATHMATCH
The host can pick Team deathmatch in the lobby. Players are split into Blue and
Red automatically and kept even. There is no timer: the first team to reach the
kill limit wins. Friendly fire is off, teammates have blue name tags, and the
scoreboard (Tab) shows both teams.

VOICE CHAT
Pick Push to talk (hold T) or Open mic in the lobby or the pause menu, and who
hears you: everyone near you (quieter with distance, from where you stand) or
your team over the radio (team deathmatch).
Browsers only allow the microphone on https pages:
- Online through the tunnel or a cloud host: already https, nothing to do.
- On a LAN: use the "With voice chat" https address the server window shows.
  The browser warns that the certificate is not trusted, because the server made
  it itself. Click Advanced, then Proceed (Chrome) or Accept the risk (Firefox).
  You only do this once per computer.
The torch key in night mode moved from T to B.

FPS AND PING
The top left corner shows frames per second and your ping to the server.

LEAN AND GRENADES
Q and E lean left and right round corners. G throws your grenade; hold G to open
the wheel and pick Frag, Smoke, Molotov or Flashbang (move the mouse toward one,
or press 1 to 4), then let go. Molotovs set the ground on fire for a few seconds.
Flashbangs blind and deafen anyone who sees them go off, you included.
