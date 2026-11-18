# AccessAI Lite

A talking camera for blind and low-vision people. You open a web page on your phone, point the camera,
and ask out loud: *"What's in front of me?"*, *"Read this"*, *"Find my keys"*. The phone answers in speech.

It was built for the Google Solution Challenge (UN Sustainable Development Goal 10, Reduced Inequalities).
It is free, needs no app install, and the vision AI runs on your own laptop instead of a paid cloud service.

---

## What it can do

| Say this (or tap the button) | What happens |
|---|---|
| "What's in front of me?" / **Describe** | Describes the scene in one or two sentences, obstacles first, with left / right / ahead |
| "Read this" / **Read** | Reads labels, bills, letters and screens aloud. Turns the torch on by itself if it's too dark |
| "Find my keys" / **Find** | Keeps looking until it sees the object, then tells you where it is ("on the table, lower left, close") |
| "What colour is this shirt?" (any question) | Answers any question about what the camera sees |
| "Start walking" / **Walk** | Warns you with vibration and voice when a person, vehicle, chair, dog and so on is close |
| **Explore** | Announces new things as they come into view |
| "Torch on", "What time is it?", "Battery", "Repeat", "Stop" | Phone helpers |
| "Help" | Gets your location and lets you share it with someone |

Some Hindi-English works too: "saamne kya hai", "padho", "meri kursi kahan hai", "madad".

---

## How it works (in simple words)

```
  PHONE (Chrome browser)                         LAPTOP
  ─────────────────────                          ──────
  camera ─┬─> small object detector  (on phone, instant: walk mode, beeps)
          │
          └─> one photo ──── internet ────> server.py
                (HTTPS tunnel)                 └─> Qwen3-VL-4B vision AI on the GPU
  speaker <── answer, sentence by sentence <──────┘
```

1. **The phone** runs the web page (`web/index.html`, `web/app.js`). It shows the camera, listens to your voice
   (Chrome speech recognition) and speaks answers (the phone's text-to-speech).
2. **A small detector runs on the phone itself** (MediaPipe EfficientDet-Lite0). It knows 80 everyday things
   (people, cars, chairs, bottles, phones...) and is instant, so it's used for walk-mode warnings and
   hot-and-cold beeping.
3. **For everything else, the phone sends one photo to your laptop.** `server.py` runs the
   **Qwen3-VL-4B** vision-language model, which can describe anything, read text, and answer questions. It
   uses a compressed 4-bit version, so it fits in a 4 GB graphics card.
4. **The answer streams back** and the phone starts speaking after the first sentence, about 1 second
   after you ask.
5. **A free Cloudflare tunnel** gives the laptop a public `https://` link. Phones only allow the camera
   and microphone on secure (https) pages, which is why the tunnel is needed.
6. **If the laptop AI is off, the app still works** in a basic mode: the phone's own detector describes
   objects and Tesseract reads text (less accurate).

Pictures go only to your own laptop. Nothing is stored. Voice recognition uses Chrome's built-in service.

---

## What you need

- A **Linux laptop** with an **NVIDIA GPU (4 GB or more)** and NVIDIA drivers installed (for the AI). Without
  a GPU you can still run the basic mode.
- **Python 3.12**
- **cloudflared** (the free tunnel program)
- An **Android phone with Chrome** (an iPhone with Safari mostly works; voice input is best in Chrome)
- Internet on both the laptop and the phone
- About **10 GB of free disk space** for the AI model (downloaded automatically on the first run)

---

## Setup (one time)

Open a terminal in this folder (the one with this README), then:

**1. Create a Python environment and install the AI libraries**

```bash
python3.12 -m venv .venv
.venv/bin/pip install torch==2.14.0 torchvision==0.29.0 --index-url https://download.pytorch.org/whl/cu130
.venv/bin/pip install -r requirements.txt
```

If your NVIDIA driver is older, use a different CUDA build of torch (for example `cu126`). Check with `nvidia-smi`.

**2. Install cloudflared**

```bash
# Arch / CachyOS / Manjaro
sudo pacman -S cloudflared

# Ubuntu / Debian
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

No Cloudflare account is needed.

**3. Make the scripts runnable**

```bash
chmod +x start.sh stop.sh
```

---

## Run

```bash
./start.sh
```

It prints a link like `https://some-random-words.trycloudflare.com`.

1. Wait about 30 seconds for the AI to load. **The first run downloads the model (~9 GB)**, which takes longer.
2. Open the link in **Chrome on your phone**.
3. Tap **Tap to start** and allow the **camera** (and later the **microphone**).
4. The pill at the top right should say **AI ready**. If it says **Basic mode**, the AI is still loading or
   the laptop server isn't running.
5. Tap the big **yellow button** and speak, or use the six buttons.

**Basic mode** (no GPU, no AI, phone-only features):

```bash
./start.sh basic
```

**Stop everything** (also frees the GPU):

```bash
./stop.sh
```

The link changes every time you run `./start.sh`, and it works only while the laptop is on and connected.

---

## Tips for good results

- Hold the phone steady, about an arm's length from what you want read.
- For reading, fill most of the screen with the text and keep it flat.
- Tap the message box to hear the last answer again. Say "stop" to end walk, explore or find mode.
- Walk mode is a helper, **not** a replacement for a white cane or a guide.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The link shows "502 Bad gateway" | The server isn't running yet or crashed. Look at `server.log`, then run `./start.sh` again |
| The status pill says "Basic mode" | The AI is still loading (wait 30 s) or out of GPU memory. Check `server.log` for `OutOfMemoryError` and close other GPU apps |
| "I need the microphone" | Chrome → ⋮ → Settings → Site settings → Microphone → allow the link |
| The camera is black | Allow the camera for the site, and make sure no other app is using it |
| Answers are slow | The GPU may be hot. Keep the laptop plugged in and cool. The first answer after starting is always slower |
| `cloudflared` not found | Install it (Setup step 2) |

The phone also sends its own status and errors to the laptop, in `phone.log`.

---

## Files

| File | What it is |
|---|---|
| `web/index.html` | The phone page: layout and buttons |
| `web/app.js` | The phone logic: camera, voice, detector, modes, talking to the laptop AI |
| `server.py` | The laptop server: serves the page and runs the Qwen3-VL-4B vision AI (`POST /ask`) |
| `serve.py` | A tiny server for basic mode (no AI) |
| `start.sh` / `stop.sh` | Start or stop the server and the tunnel |
| `requirements.txt` | Python libraries for the AI server |

## Built with

Qwen3-VL-4B-Instruct (Alibaba Qwen team), Hugging Face Transformers and bitsandbytes (4-bit), Google
MediaPipe (EfficientDet-Lite0), Tesseract.js, the Web Speech API, and Cloudflare Tunnel.
