"""AccessAI Lite server: serves the web app and answers camera questions with a local
vision-language model (Qwen3-VL-4B-Instruct, 4-bit NF4) on the laptop GPU.

Run (normally through ./start.sh):
    .venv/bin/python server.py [port]
Endpoints:
    GET  /...        static files (index.html, app.js)
    POST /ask        {"image": <base64 jpeg>, "mode": "describe|read|find|ask", "q": "..."}
                     -> text/event-stream of plain text chunks (sentence streaming)
    GET  /health     {"ready": bool, "model": ...}
    POST /log        phone diagnostics -> phone.log
"""
import base64
import functools
import http.server
import io
import json
import mimetypes
import sys
import threading
import time
from pathlib import Path

import os
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
import torch
from PIL import Image
import re
from transformers import (AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig, StoppingCriteria,
                          StoppingCriteriaList, TextIteratorStreamer)


class StopOnLoop(StoppingCriteria):
    """Stop when the model degenerates into repeating one character or a short pattern (e.g. '0000...')."""
    def __init__(self, tok, start):
        self.tok, self.start = tok, start

    def __call__(self, ids, scores, **kw):
        if ids.shape[1] - self.start < 12:
            return False
        tail = self.tok.decode(ids[0, -24:], skip_special_tokens=True)
        return bool(re.search(r"(.)\1{9,}", tail) or re.search(r"(.{2,6}?)\1{5,}", tail))

HERE = Path(__file__).parent
MODEL_ID = "Qwen/Qwen3-VL-4B-Instruct"
MAX_SIDE = 640                       # phone sends <= 640 px; Qwen packs 32x32 px per visual token
READ_PIXELS = 1024 * 768             # reading needs detail: about 750 visual tokens
READ_SIDE = 1280
PIXELS = (320 * 320, 512 * 384)      # min/max pixels -> roughly 100-200 visual tokens
GPU = threading.Lock()
state = {"ready": False, "model": MODEL_ID, "warm_s": None}

PROMPTS = {
    "describe": ("You are the eyes of a blind person pointing their phone camera. In one or two short sentences "
                 "(under 30 words), say what is in front of them. Mention any obstacle or hazard first, then the main things, "
                 "nearest first, using left, right or ahead. Speak naturally in full sentences, like a friend would. No preamble.", 55),
    "read": ("Read the text in this image for a blind person. First say in a few words what it is (for example: medicine "
             "strip, bill, sign). Then read the important text exactly as written, top to bottom. Read numbers, prices "
             "and dates carefully. If there is no readable text, say only: No readable text.", 220),
    "find": ("A blind person is looking for: {q}. Look carefully at the image. If it is visible, answer in one short sentence "
             "saying where it is, using left, right or centre, and near or far, for example: Your keys are on the table, "
             "lower left, close. If it is not visible, answer only: NOT FOUND", 40),
    "ask": ("A blind person asks about what their phone camera sees: \"{q}\". Answer in one or two short sentences, "
            "using only what is clearly visible. If you cannot tell, say so.", 90),
}

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")


def load():
    t = time.time()
    if not torch.cuda.is_available():
        print("ERROR: CUDA GPU is not available. server.py requires an NVIDIA GPU with CUDA. For CPU systems, use serve.py (basic mode).", flush=True)
        return
    try:
        proc = AutoProcessor.from_pretrained(MODEL_ID, min_pixels=PIXELS[0], max_pixels=PIXELS[1])
        state["proc_read"] = AutoProcessor.from_pretrained(MODEL_ID, min_pixels=PIXELS[0], max_pixels=READ_PIXELS)
        model = AutoModelForImageTextToText.from_pretrained(
            MODEL_ID, torch_dtype=torch.float16, device_map="cuda",
            quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16,
                                                   bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True)).eval()
        state.update(proc=proc, net=model)
        print(f"loaded in {time.time() - t:.1f}s, GPU {torch.cuda.memory_allocated() / 2**30:.2f} GiB", flush=True)
        # warm-up so the first real question is fast
        t = time.time()
        for m in ("describe", "read"):
            for _ in stream(Image.new("RGB", (1280, 960) if m == "read" else (640, 480), (120, 120, 120)), m, ""):
                pass
        state["warm_s"] = round(time.time() - t, 2)
        state["ready"] = True
        print(f"ready (warm-up {state['warm_s']}s)", flush=True)
    except Exception as e:
        print(f"Failed to load AI model: {e}", flush=True)


def stream(img, mode, q):
    """Yield text chunks for one question; the GPU lock keeps requests one at a time."""
    prompt, max_new = PROMPTS.get(mode, PROMPTS["ask"])
    text = prompt.format(q=q.strip()[:200])
    msgs = [{"role": "user", "content": [{"type": "image", "image": img}, {"type": "text", "text": text}]}]
    proc, model = (state["proc_read"] if mode == "read" else state["proc"]), state["net"]
    with GPU:
        inputs = proc.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True, return_dict=True,
                                          return_tensors="pt").to(model.device)
        streamer = TextIteratorStreamer(proc.tokenizer, skip_prompt=True, skip_special_tokens=True)
        stop = StoppingCriteriaList([StopOnLoop(proc.tokenizer, inputs["input_ids"].shape[1])])
        th = threading.Thread(target=lambda: model.generate(**inputs, streamer=streamer, max_new_tokens=max_new,
                                                            do_sample=False, repetition_penalty=1.05,
                                                            stopping_criteria=stop))
        th.start()
        for chunk in streamer:
            if chunk:
                yield chunk
        th.join()


class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({k: v for k, v in state.items() if k in ("ready", "model", "warm_s")}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        n = min(int(self.headers.get("Content-Length", 0)), 4_000_000)
        raw = self.rfile.read(n)
        if self.path == "/log":
            with open(HERE / "phone.log", "a") as f:
                f.write(time.strftime("%H:%M:%S ") + raw.decode("utf-8", "replace").replace("\n", " | ") + "\n")
            self.send_response(204); self.send_header("Content-Length", "0"); self.end_headers()
            return
        if self.path != "/ask":
            self.send_error(404); return
        if not state["ready"]:
            self.send_response(503); self.send_header("Content-Length", "0"); self.end_headers(); return
        t0 = time.time()
        try:
            req = json.loads(raw)
            img = Image.open(io.BytesIO(base64.b64decode(req["image"].split(",")[-1]))).convert("RGB")
            side = READ_SIDE if req.get("mode") == "read" else MAX_SIDE
            img.thumbnail((side, side))
            mode, q = req.get("mode", "describe"), req.get("q", "")
        except Exception as e:
            self.send_error(400, str(e)); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        out, first = [], None
        try:
            for chunk in stream(img, mode, q):
                if first is None:
                    first = time.time() - t0
                out.append(chunk)
                self.wfile.write(chunk.encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        total = time.time() - t0
        with open(HERE / "phone.log", "a") as f:
            f.write(time.strftime("%H:%M:%S ") + f"ask mode={mode} q={q!r} first={first and round(first, 2)}s "
                    f"total={total:.2f}s img={img.size} -> {''.join(out)!r}\n")
        self.close_connection = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    threading.Thread(target=load, daemon=True).start()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=str(HERE / "web")))
    print(f"serving on 127.0.0.1:{port}", flush=True)
    srv.serve_forever()
