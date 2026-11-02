#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
node server.js
