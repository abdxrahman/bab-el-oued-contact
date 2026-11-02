#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared is not installed. Mac: brew install cloudflared   Linux: see developers.cloudflare.com"; exit 1; }
node server.js &
sleep 2
echo "Your public link is the line ending in trycloudflare.com"
cloudflared tunnel --url http://localhost:8080
