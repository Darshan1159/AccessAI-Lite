"""Serve AccessAI Lite on 127.0.0.1:8765 (pair with a cloudflared tunnel for HTTPS).
POST /log appends the phone's diagnostic lines to phone.log so problems can be debugged."""
import functools, http.server, json, mimetypes, sys, time
from pathlib import Path
HERE = Path(__file__).parent
mimetypes.add_type("text/javascript", ".js"); mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({"ready": False, "model": "none", "mode": "basic"}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        super().do_GET()
    def do_POST(self):
        if self.path.startswith("/health"):
            self.do_GET(); return
        if self.path == "/ask":
            self.send_response(503); self.send_header("Content-Length", "0"); self.end_headers(); return
        if self.path != "/log":
            self.send_error(404); return
        n = min(int(self.headers.get("Content-Length", 0)), 20000)
        body = self.rfile.read(n).decode("utf-8", "replace")
        with open(HERE / "phone.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + body.replace("\n", " | ") + "\n")
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=str(HERE / "web"))).serve_forever()
