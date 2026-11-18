#!/bin/sh
# Stop AccessAI Lite (server and tunnel). Frees the GPU memory.
PORT="${PORT:-8765}"
pkill -f "server.py $PORT"
pkill -f "serve.py $PORT"
pkill -f "cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT"
echo "Stopped."
