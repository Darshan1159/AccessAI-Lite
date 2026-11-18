#!/bin/sh
# Start AccessAI Lite and print the link to open on your phone.
#   ./start.sh          full version: laptop AI (needs an NVIDIA GPU and the .venv from setup)
#   ./start.sh basic    basic version: no AI, everything runs on the phone (any computer works)
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8765}"
PY="${PYTHON:-./.venv/bin/python}"

./stop.sh >/dev/null 2>&1
if [ "$1" = "basic" ]; then
  setsid nohup python3 serve.py "$PORT" > server.log 2>&1 &
  echo "Started in BASIC mode (no laptop AI)."
else
  [ -x "$PY" ] || { echo "No Python environment found at $PY. Run the setup steps in README.md first."; exit 1; }
  setsid nohup "$PY" server.py "$PORT" > server.log 2>&1 &
  echo "Started in AI mode. The AI model needs about 30 seconds to load (the first run downloads ~9 GB)."
fi

command -v cloudflared >/dev/null || { echo "cloudflared is not installed, see README.md."; exit 1; }
setsid nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > tunnel.log 2>&1 &
for i in $(seq 1 40); do
  url=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" tunnel.log | head -1)
  if [ -n "$url" ]; then
    echo "$url" > url.txt
    echo ""
    echo "Open this link in Chrome on your phone:"
    echo "  $url"
    echo "(It can take up to a minute before the link starts working.)"
    exit 0
  fi
  sleep 1
done
echo "The tunnel did not start. Check tunnel.log and your internet connection." >&2
exit 1
