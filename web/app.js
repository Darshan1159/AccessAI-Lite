// AccessAI Lite — talking camera for blind and low-vision users.
// Everything visual runs on the phone: MediaPipe EfficientDet-Lite0 (objects) and Tesseract.js (text).
import { FilesetResolver, ObjectDetector } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const $ = (id) => document.getElementById(id);
function rlog(...a) {
  const msg = a.map((x) => (typeof x === "string" ? x : (x && x.stack) || JSON.stringify(x))).join(" ");
  try { fetch("./log", { method: "POST", body: msg.slice(0, 4000), keepalive: true }).catch(() => {}); } catch (_) {}
}
window.addEventListener("error", (e) => rlog("ERROR", e.message, e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => rlog("REJECT", e.reason));
rlog("open", navigator.userAgent);
const video = $("video"), overlay = $("overlay"), sayEl = $("say"), statusEl = $("status"), qualityEl = $("quality");
const work = document.createElement("canvas");
const wctx = work.getContext("2d", { willReadFrequently: true });

let detectorOpts = null, detectorFileset = null, backend = "", detFails = 0, frames = 0;
let detector = null, ocrWorker = null, track = null;
let mode = "idle";          // idle | explore | walk | find
let findTarget = null;      // { labels:[...], name }
let torchOn = false, reading = false, lastSaid = "", dets = [];
const seen = {};            // label -> timing, for explore mode
const warned = {};          // cooldowns for walk mode

const HAZARDS = new Set(["person", "bicycle", "car", "motorcycle", "bus", "truck", "dog", "cow", "horse",
  "chair", "bench", "dining table", "couch", "potted plant", "fire hydrant", "stop sign", "suitcase", "bed", "toilet"]);

// words people say -> COCO labels the detector knows
const OBJECTS = {
  "phone": ["cell phone"], "mobile": ["cell phone"], "cell phone": ["cell phone"],
  "bottle": ["bottle"], "water": ["bottle"], "cup": ["cup"], "glass": ["cup", "wine glass"], "mug": ["cup"],
  "chair": ["chair"], "kursi": ["chair"], "seat": ["chair", "bench", "couch"], "sofa": ["couch"], "couch": ["couch"],
  "bench": ["bench"], "table": ["dining table"], "bed": ["bed"], "toilet": ["toilet"], "sink": ["sink"],
  "bag": ["backpack", "handbag", "suitcase"], "backpack": ["backpack"], "handbag": ["handbag"], "suitcase": ["suitcase"],
  "laptop": ["laptop"], "computer": ["laptop", "tv"], "tv": ["tv"], "television": ["tv"], "remote": ["remote"],
  "keyboard": ["keyboard"], "mouse": ["mouse"], "book": ["book"], "clock": ["clock"], "umbrella": ["umbrella"],
  "scissors": ["scissors"], "toothbrush": ["toothbrush"], "plant": ["potted plant"], "bowl": ["bowl"],
  "spoon": ["spoon"], "fork": ["fork"], "knife": ["knife"], "banana": ["banana"], "apple": ["apple"], "orange": ["orange"],
  "person": ["person"], "people": ["person"], "someone": ["person"], "man": ["person"], "woman": ["person"], "aadmi": ["person"],
  "dog": ["dog"], "cat": ["cat"], "car": ["car"], "bus": ["bus"], "bike": ["bicycle", "motorcycle"], "cycle": ["bicycle"],
  "bicycle": ["bicycle"], "scooter": ["motorcycle"], "motorcycle": ["motorcycle"], "truck": ["truck"],
  "traffic light": ["traffic light"], "signal": ["traffic light"],
};
const UNSUPPORTED = ["key", "keys", "chabi", "door", "darwaza", "wallet", "glasses", "specs", "stairs", "charger", "shoe", "pen", "medicine"];

// ---------------------------------------------------------------- output: speech, haptics, sound
function say(text, { queue = false, note = "Tap here to repeat", silent = false } = {}) {
  lastSaid = text;
  sayEl.textContent = text;
  const s = document.createElement("small"); s.textContent = note; sayEl.append(s);
  if (silent || !("speechSynthesis" in window)) return;
  if (!queue) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-IN"; u.rate = 1.05;
  speechSynthesis.speak(u);
}
const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };
let actx = null;
function beep(freq = 880, ms = 70, vol = 0.25) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = "sine";
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + ms / 1000);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + ms / 1000 + 0.02);
  } catch (_) {}
}
const setStatus = (t) => { statusEl.textContent = t; };

// ---------------------------------------------------------------- laptop AI (Qwen3-VL-4B over the tunnel)
let aiReady = false, aiCtl = null;
async function checkAI() {
  try { const h = await (await fetch("./health", { cache: "no-store" })).json(); aiReady = !!h.ready; }
  catch (_) { aiReady = false; }
  setStatus(aiReady ? (mode === "idle" ? "AI ready" : statusEl.textContent) : "Basic mode");
  return aiReady;
}
function frameJPEG(side = 640) {
  const c = grab(side);
  return c.toDataURL("image/jpeg", side > 640 ? 0.88 : 0.8);
}
// Ask the laptop model; speaks each sentence as soon as it arrives. Returns the full answer, or null on failure.
async function askAI(aiMode, q = "", { speakIt = true, prefix = "" } = {}) {
  if (!aiReady) return null;
  if (aiCtl) aiCtl.abort();
  const ctl = aiCtl = new AbortController();
  const t0 = performance.now();
  let full = "", spoken = 0, firstSpoken = false;
  const speakUpTo = (end) => {
    const part = ((spoken === 0 ? prefix : "") + full.slice(spoken, end).trim()).replace(/(.)\1{5,}/g, "$1$1$1").replace(/(.{2,6}?)\1{4,}/g, "$1");
    spoken = end;
    if (!part || !speakIt) return;
    say(full.trim(), { queue: firstSpoken, silent: true });
    const u = new SpeechSynthesisUtterance(part); u.lang = "en-IN"; u.rate = 1.05;
    if (!firstSpoken) speechSynthesis.cancel();
    speechSynthesis.speak(u); firstSpoken = true;
  };
  try {
    const r = await fetch("./ask", { method: "POST", body: JSON.stringify({ image: frameJPEG(aiMode === "read" ? 1280 : 640), mode: aiMode, q }), signal: ctl.signal,
                                   headers: { "Content-Type": "application/json" } });
    if (!r.ok) { if (r.status === 503) aiReady = false; return null; }
    const rd = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      full += dec.decode(value, { stream: true });
      if (speakIt) sayEl.firstChild ? (sayEl.firstChild.textContent = full) : (sayEl.textContent = full);
      // speak every finished sentence (or line) straight away
      const m = [...full.slice(spoken).matchAll(/[.!?](\s|$)|\n/g)];
      const last = m.filter((x) => x.index + x[0].length <= full.length - spoken && x[0] !== "" && (x[1] !== "" || x[0] === "\n")).pop();
      if (last) speakUpTo(spoken + last.index + last[0].length);
    }
    if (spoken < full.length) speakUpTo(full.length);
    rlog("ai", aiMode, Math.round(performance.now() - t0) + "ms", JSON.stringify(full.slice(0, 200)));
    lastSaid = (prefix + full).trim();
    return full.trim();
  } catch (e) {
    if (e.name !== "AbortError") { rlog("ai failed", e); aiReady = false; checkAI(); }
    return null;
  } finally { if (aiCtl === ctl) aiCtl = null; }
}

// ---------------------------------------------------------------- startup
async function start() {
  const btn = $("startBtn");
  btn.disabled = true; btn.textContent = "Starting…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    track = stream.getVideoTracks()[0];
    await video.play();
  } catch (e) {
    $("startNote").textContent = "The camera is blocked. Allow camera access for this site in Chrome settings, then tap again.";
    btn.disabled = false; btn.textContent = "Try again";
    say("I could not open the camera. Please allow camera access and tap again.");
    return;
  }
  $("start").hidden = true;
  beep(660, 60);
  keepAwake();
  setStatus("Loading");
  say("Camera on. Getting ready.", { note: "Loading the vision model" });
  try {
    const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/latest/efficientdet_lite0.tflite", delegate },
      runningMode: "VIDEO", scoreThreshold: 0.35, maxResults: 12 });
    detectorOpts = opts; detectorFileset = fileset;
    try { detector = await ObjectDetector.createFromOptions(fileset, opts("CPU")); backend = "CPU"; }
    catch (e) { rlog("CPU delegate failed", e); detector = await ObjectDetector.createFromOptions(fileset, opts("GPU")); backend = "GPU"; }
    rlog("detector ready", backend, video.videoWidth + "x" + video.videoHeight);
  } catch (e) {
    console.error(e); rlog("model load failed", e); setStatus("Offline");
    say("The vision model could not load. Check your internet and reload the page.");
    return;
  }
  await checkAI();
  setInterval(checkAI, 15000);
  requestAnimationFrame(loop);
  setInterval(updateQuality, 700);
  setInterval(() => { const q = frameQuality(); rlog("diag", JSON.stringify({ backend, frames, dets: dets.map((o) => o.label + ":" + o.score.toFixed(2)), q: q.issue, sharp: Math.round(q.sharp || 0), mean: Math.round(q.mean || 0), mode, vid: video.videoWidth + "x" + video.videoHeight })); }, 5000);
  // warm up the text reader in the background so the first "read" is fast
  Tesseract.createWorker("eng").then((w) => { ocrWorker = w; }).catch(() => {});
  let first = true;
  try { first = !localStorage.getItem("aal-seen"); localStorage.setItem("aal-seen", "1"); } catch (_) {}
  setTimeout(() => {
    if (first) say("Ready. Tap the big yellow button and ask me anything, like: what's in front of me, read this, find my keys, what colour is this, or start walking. The six buttons below do the same things.");
    else describe(true);
  }, 700);
}
async function keepAwake() { try { await navigator.wakeLock.request("screen"); } catch (_) {} }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (mode !== "idle") setMode("idle", { silent: true }); }
  else if (track) keepAwake();
});

// ---------------------------------------------------------------- detection loop
let lastRun = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  if (!detector || video.readyState < 2 || reading) return;
  const interval = mode === "idle" ? 450 : 160;
  if (ts - lastRun < interval) return;
  lastRun = ts;
  try { dets = (detector.detectForVideo(video, performance.now()).detections || []).map(toObj).filter(Boolean); frames++; detFails = 0; }
  catch (e) {
    if (++detFails % 20 === 1) rlog("detect failed", backend, e);
    return;
  }
  draw();
  if (mode === "walk") walkTick();
  else if (mode === "explore") exploreTick();
  else if (mode === "find" && !findTarget?.ai) findTick();
}

function toObj(d) {
  const b = d.boundingBox, vw = video.videoWidth, vh = video.videoHeight;
  if (!b || !vw || !vh) return null;
  const c = (d.categories && d.categories[0]) || { categoryName: "object", score: 0 };
  const cx = (b.originX + b.width / 2) / vw, area = (b.width * b.height) / (vw * vh);
  const bottom = (b.originY + b.height) / vh;
  const side = cx < 0.33 ? "on your left" : cx > 0.67 ? "on your right" : cx < 0.45 ? "slightly left" : cx > 0.55 ? "slightly right" : "straight ahead";
  const dist = area > 0.25 || bottom > 0.95 ? "very close" : area > 0.08 ? "close" : area > 0.02 ? "a few steps away" : "far";
  return { label: c.categoryName, score: c.score, box: b, cx, area, bottom, side, dist };
}

function draw() {
  const W = overlay.clientWidth, H = overlay.clientHeight;
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  const g = overlay.getContext("2d");
  g.clearRect(0, 0, W, H);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  g.font = "bold 15px system-ui"; g.textBaseline = "top";
  for (const o of dets) {
    if (!o || !o.box) continue;
    const target = mode === "find" && findTarget?.labels.includes(o.label);
    const x = ox + o.box.originX * s, y = oy + o.box.originY * s, w = o.box.width * s, h = o.box.height * s;
    g.strokeStyle = target ? "#3ddc84" : HAZARDS.has(o.label) ? "#ffd23f" : "#8fb3ff";
    g.lineWidth = target ? 5 : 3;
    g.strokeRect(x, y, w, h);
    const label = `${o.label} · ${o.dist}`;
    g.fillStyle = "rgba(0,0,0,.72)"; g.fillRect(x, Math.max(0, y - 21), g.measureText(label).width + 10, 21);
    g.fillStyle = "#fff"; g.fillText(label, x + 5, Math.max(0, y - 19));
  }
}

// ---------------------------------------------------------------- describe
const plural = (w) => (w === "person" ? "people" : w.endsWith("s") ? w : w + "s");
const article = (w) => (/^[aeiou]/.test(w) ? "an" : "a");
const listJoin = (a) => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a.at(-1));
const DIST_RANK = { "very close": 0, "close": 1, "a few steps away": 2, "far": 3 };

async function describe(auto = false) {
  if (aiReady) {
    beep(880, 40, 0.15);
    const q = frameQuality();
    if (q.issue === "dark" && !torchOn) await setTorch(true, true);
    const a = await askAI("describe");
    if (a !== null) return;
  }
  return describeLocal(auto);
}
function describeLocal(auto = false) {
  rlog("describe", JSON.stringify({ frames, dets: dets.map((o) => o.label + ":" + o.score.toFixed(2)) }));
  if (!detector) return say("Still getting ready, one moment.");
  const q = frameQuality();
  const good = dets.filter((o) => o.score >= 0.45);
  if (!good.length) {
    if (q.issue) return say(q.hint);
    return say(auto ? "Ready. I don't see any familiar objects yet. Tap the yellow button to ask me something."
                    : "I don't see any objects I know. Point the phone a little up or around. If there is text, say read this.");
  }
  const groups = {};
  for (const o of good) (groups[o.label] = groups[o.label] || []).push(o);
  const parts = Object.entries(groups)
    .map(([label, items]) => ({ label, items, nearest: items.reduce((a, b) => (DIST_RANK[a.dist] <= DIST_RANK[b.dist] ? a : b)) }))
    .sort((a, b) => DIST_RANK[a.nearest.dist] - DIST_RANK[b.nearest.dist] || b.items.length - a.items.length)
    .slice(0, 5)
    .map((g) => g.items.length > 1
      ? `${g.items.length} ${plural(g.label)}, the nearest ${g.nearest.side}, ${g.nearest.dist}`
      : `${article(g.label)} ${g.label} ${g.nearest.side}, ${g.nearest.dist}`);
  say((auto ? "Ready. " : "") + "I can see " + listJoin(parts) + "." + (q.issue === "dark" ? " It's quite dark, so I may miss things." : ""));
}

// ---------------------------------------------------------------- modes
function setMode(m, opts = {}) {
  mode = m;
  for (const [id, mm] of [["bExplore", "explore"], ["bWalk", "walk"], ["bFind", "find"]]) {
    $(id).classList.toggle("on", m === mm); $(id).setAttribute("aria-pressed", String(m === mm));
  }
  const badge = $("modeBadge");
  badge.hidden = m === "idle";
  badge.textContent = m === "find" ? `FINDING ${(findTarget?.name || "").toUpperCase()}` : m.toUpperCase();
  for (const k of Object.keys(seen)) delete seen[k];
  setStatus(m === "idle" ? (aiReady ? "AI ready" : "Basic mode") : m[0].toUpperCase() + m.slice(1));
  if (opts.silent) return;
  if (m === "walk") say("Walk mode on. I'll warn you about close obstacles. Keep using your cane. Say stop to end.");
  if (m === "explore") say("Explore mode on. I'll tell you when new things come into view. Move the phone slowly.");
  if (m === "idle") { aiFindRun++; if (aiCtl) aiCtl.abort(); say("Stopped."); }
}

function walkTick() {
  const now = Date.now();
  const hazard = dets.filter((o) => o.score >= 0.5 && HAZARDS.has(o.label) && (o.dist === "very close" || o.dist === "close"))
    .sort((a, b) => DIST_RANK[a.dist] - DIST_RANK[b.dist])[0];
  if (!hazard) return;
  const key = hazard.label + hazard.side;
  if (now - (warned[key] || 0) < (hazard.dist === "very close" ? 2500 : 4500)) return;
  warned[key] = now;
  const centre = hazard.side === "straight ahead" || hazard.side.startsWith("slightly");
  buzz(hazard.dist === "very close" ? [250, 80, 250, 80, 250] : centre ? [180, 80, 180] : [120]);
  beep(hazard.dist === "very close" ? 1200 : 900, 90, 0.3);
  say(`${hazard.label} ${hazard.side}, ${hazard.dist}`, { queue: true });
}

function exploreTick() {
  const now = Date.now();
  for (const o of dets) {
    if (o.score < 0.5) continue;
    const s = seen[o.label] || (seen[o.label] = { first: now, last: 0, said: 0 });
    if (now - s.last > 3000) s.first = now;              // came back into view
    s.last = now;
    if (now - s.first > 400 && now - s.said > 10000) {   // steady for 0.4 s, not mentioned for 10 s
      s.said = now; beep(700, 50, 0.15);
      say(`${o.label}, ${o.side}`, { queue: true });
      break;
    }
  }
}

// find: hot-and-cold beeps that speed up and rise in pitch as the object gets centred and closer
let lastFindBeep = 0, lastFindSay = 0, lastFindSeen = 0;
function findTick() {
  const now = Date.now();
  const hit = dets.filter((o) => findTarget.labels.includes(o.label) && o.score >= 0.4).sort((a, b) => b.area - a.area)[0];
  if (!hit) {
    if (now - lastFindSeen > 1500 && now - lastFindSay > 6000) { lastFindSay = now; say(`Still looking for the ${findTarget.name}. Turn slowly.`, { queue: true }); }
    return;
  }
  lastFindSeen = now;
  const off = Math.abs(hit.cx - 0.5);                    // 0 = centred
  if (now - lastFindBeep > 120 + off * 1600) { lastFindBeep = now; beep(500 + (1 - off * 2) * 700 + Math.min(hit.area, 0.3) * 1000, 60, 0.25); }
  if (now - lastFindSay > 3500) {
    lastFindSay = now;
    if (off < 0.1 && hit.area > 0.2) { buzz([100, 60, 100]); say(`The ${findTarget.name} is right in front of you, within reach.`, { queue: true }); }
    else say(`${findTarget.name} ${hit.side}, ${hit.dist}`, { queue: true });
  }
}
function startFind(words) {
  const w = " " + (words || "").toLowerCase().trim() + " ";
  if (!w.trim()) return listen("find");
  const key = Object.keys(OBJECTS).sort((a, b) => b.length - a.length).find((k) => w.includes(" " + k));
  if (aiReady && (!key || UNSUPPORTED.some((u) => w.includes(" " + u)))) return startAIFind(words.trim().replace(/^(my|the|a|an|mera|meri)\s+/, ""));
  if (UNSUPPORTED.some((u) => w.includes(" " + u))) return say(`Sorry, I can't recognise that without the laptop AI. I can find things like bottles, cups, phones, chairs, bags, laptops, books and people.`);
  if (!key) return say(`I don't know how to find "${words.trim()}" without the laptop AI. Try a bottle, cup, phone, chair, bag, laptop, book or person.`);
  const name = { kursi: "chair", aadmi: "person", mobile: "phone", water: "bottle" }[key] || key;
  findTarget = { labels: OBJECTS[key], name };
  lastFindSay = lastFindSeen = Date.now();
  setMode("find", { silent: true });
  say(`Looking for the ${name}. Move the phone slowly around. The beeps get faster when you point at it.`);
}

// find anything with the laptop AI: keep asking until it's visible, then keep guiding
let aiFindRun = 0;
async function startAIFind(thing) {
  const run = ++aiFindRun;
  findTarget = { labels: [], name: thing, ai: true };
  setMode("find", { silent: true });
  say(`Looking for ${thing}. Move the phone slowly around.`);
  await sleep(1800);
  let lastMsg = "", lastTalk = Date.now(), lastFound = 0;
  while (run === aiFindRun && mode === "find") {
    const a = await askAI("find", thing, { speakIt: false });
    if (run !== aiFindRun || mode !== "find") break;
    if (a === null) { say("The laptop AI isn't answering. Stopping the search."); setMode("idle", { silent: true }); break; }
    const now = Date.now();
    if (/NOT FOUND/i.test(a)) {
      if (now - lastTalk > 6000) { lastTalk = now; beep(400, 60, 0.12); say(`Still looking for ${thing}. Turn slowly.`); }
    } else {
      beep(1200, 80, 0.3); buzz([100, 50, 100]);
      if (a !== lastMsg || now - lastFound > 5000) { say(a); lastMsg = a; lastTalk = lastFound = now; await sleep(2200); }
    }
    await sleep(250);
  }
}

// ---------------------------------------------------------------- capture-quality gate
function grab(maxSide) {
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, maxSide / Math.max(vw, vh));
  work.width = Math.round(vw * s); work.height = Math.round(vh * s);
  wctx.drawImage(video, 0, 0, work.width, work.height);
  return work;
}
function frameQuality() {
  if (video.readyState < 2) return { issue: null };
  const c = grab(240), w = c.width, h = c.height, px = wctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h); let sum = 0;
  for (let i = 0; i < w * h; i++) { const v = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]; gray[i] = v; sum += v; }
  const mean = sum / (w * h); let m = 0, m2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, lap = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
    m += lap; m2 += lap * lap; n++;
  }
  const sharp = m2 / n - (m / n) ** 2;
  if (mean < 35) return { issue: "dark", hint: "It's too dark to see. Say torch on, or move to more light.", sharp, mean };
  if (mean > 240) return { issue: "glare", hint: "There's too much glare. Tilt the phone a little.", sharp, mean };
  if (sharp < 20) return { issue: "blur", hint: "The picture is blurry. Hold the phone still, a little farther away.", sharp, mean };
  return { issue: null, sharp, mean };
}
function updateQuality() {
  const q = frameQuality();
  qualityEl.textContent = q.issue === "blur" ? "Blurry" : q.issue === "dark" ? "Too dark" : q.issue === "glare" ? "Glare" : "Clear view";
  qualityEl.className = "pill " + (q.issue ? "bad" : "ok");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- reading: waits for a sharp frame, torch on if dark
async function readText() {
  if (reading) return;
  reading = !aiReady; setStatus("Reading");
  try {
    let q = frameQuality();
    if (q.issue === "dark" && !torchOn && await setTorch(true, true)) { await sleep(700); q = frameQuality(); }
    if (q.issue) {
      say("Hold still, waiting for a clear picture.", { note: q.hint });
      for (let i = 0; i < 12 && (q = frameQuality()).issue; i++) await sleep(250);
      if (q.issue) { buzz(80); say(q.hint); return; }
    }
    beep(880, 50);
    if (aiReady) {
      say("Reading.", { note: "Hold still" });
      const a = await askAI("read");
      if (a !== null) return;
    }
    say("Reading.", { note: "Hold still" });
    const frame = grab(1600);
    if (!ocrWorker) ocrWorker = await Tesseract.createWorker("eng");
    const { data } = await ocrWorker.recognize(frame);
    rlog("ocr", Math.round(data.confidence), JSON.stringify(data.text.slice(0, 300)));
    const lines = data.text.split("\n").map((l) => l.replace(/\s+/g, " ").trim())
      .filter((l) => { const a = (l.match(/[A-Za-z0-9]/g) || []).length; return a >= 3 && a / l.length > 0.5; });
    if (!lines.length || data.confidence < 35) say("I couldn't find readable text. Bring the text a bit closer, keep it flat, and try again.");
    else say((data.confidence < 60 ? "I'm not fully sure, but it says: " : "It says: ") + lines.join(". "));
  } catch (e) {
    console.error(e); rlog("ocr failed", e);
    say("Reading failed. Check your internet connection and try again.");
  } finally { reading = false; setStatus(mode === "idle" ? (aiReady ? "AI ready" : "Basic mode") : mode[0].toUpperCase() + mode.slice(1)); }
}

// ---------------------------------------------------------------- torch
async function setTorch(on, quiet = false) {
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    torchOn = on;
    $("bTorch").classList.toggle("on", on); $("bTorch").setAttribute("aria-pressed", String(on));
    if (!quiet) say(on ? "Torch on." : "Torch off."); else if (on) say("It's dark, so I turned the torch on.");
    return true;
  } catch (_) { if (!quiet) say("This phone doesn't let the browser use the torch."); return false; }
}

// ---------------------------------------------------------------- voice commands (English + some Hinglish)
function route(text) {
  rlog("heard", JSON.stringify(text));
  const t = " " + text.toLowerCase().replace(/[’'?.!,]/g, "") + " ";
  const has = (...w) => w.some((x) => t.includes(x));
  const findMatch = t.match(/\b(?:find|where is|where are|wheres|look for|search for|search|locate|dhoond\w*)\s+(?:my |the |a |an |mera |meri )?([a-z ]+)/)
    || t.match(/\b(?:mera |meri )?([a-z]+) kahan hai/);
  if (has(" stop ", " band ", " cancel ", " ruko ", " quiet ", " shut up ")) { speechSynthesis.cancel(); return setMode("idle"); }
  if (has(" repeat ", " again ", " phir se ", " dobara ")) return say(lastSaid);
  if (findMatch) return startFind(findMatch[1]);
  if (has(" help ", " madad ", " bachao ", " emergency ", " lost ")) return sos();
  if (has(" walk", " obstacle", " chal", " road ")) return setMode("walk");
  if (has(" explore", " around me ", " keep telling", " auto")) return setMode("explore");
  if (has(" torch", " flash", " light ", " roshni")) return setTorch(!has(" off", " band"));
  if (has(" read", " padh", " likha", " written", " says ", " label", " text", " menu", " bill", " note ")) return readText();
  if (has(" time ", " samay", " baje")) return say("It is " + new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) + ".");
  if (has(" battery")) return battery();
  if (has(" what can you do", " how do i", " commands", " options")) return say("Ask me anything about what the camera sees. For example: what's in front of me, read this, find my keys, what colour is this shirt, which note is this, start walking, torch on, repeat, or help to share your location.");
  const words = t.trim().split(/\s+/).length;
  if (has(" describe", " in front", " ahead", " around me", " saamne", " dikh", " scene", " what do you see", " what can you see", " whats here", " what is here", " where am i") || (words <= 3 && has(" what", " see", " look"))) return describe();
  if (has(" does it say", " does this say", " is written")) return readText();
  if (aiReady) { beep(880, 40, 0.15); return askAI("ask", text).then((a) => { if (a === null) say("The laptop AI didn't answer. Try again."); }); }
  if (has(" what", " see", " look")) return describe();
  const obj = Object.keys(OBJECTS).find((k) => t.includes(" " + k + " "));   // a bare object name means "find it"
  if (obj) return startFind(obj);
  say(`I heard "${text.trim()}". Try: what's in front of me, read this, find my phone, or start walking.`);
}
async function battery() {
  try { const b = await navigator.getBattery(); say(`Battery is at ${Math.round(b.level * 100)} percent${b.charging ? " and charging" : ""}.`); }
  catch (_) { say("I can't read the battery level in this browser."); }
}
function sos() {
  buzz([300, 100, 300, 100, 300]);
  if (!navigator.geolocation) return say("Location isn't available. Please call someone you trust.");
  say("Getting your location so you can share it.");
  navigator.geolocation.getCurrentPosition(async (p) => {
    const link = `https://maps.google.com/?q=${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`;
    const msg = `I need help. My location: ${link}`;
    if (navigator.share) { try { say("Choose who to send your location to."); await navigator.share({ text: msg }); return; } catch (_) {} }
    say(msg, { note: "Share this with someone you trust" });
  }, () => say("I couldn't get your location. Please call someone you trust."), { enableHighAccuracy: true, timeout: 10000 });
}

// ---------------------------------------------------------------- listening: tap to talk, stops on silence
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function listen(purpose = "command") {
  if (!SR) return say("Voice input needs Chrome. You can still use the six buttons.");
  if (rec) { try { rec.stop(); } catch (_) {} return; }
  speechSynthesis.cancel();
  let heard = "";
  rec = new SR();
  rec.lang = "en-IN"; rec.interimResults = true; rec.continuous = false;
  rec.onresult = (ev) => {
    heard = Array.from(ev.results).map((r) => r[0].transcript).join(" ");
    sayEl.textContent = "“" + heard + "”";
  };
  rec.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") say("I need the microphone. Allow it for this site in Chrome settings, or use the buttons.");
    else if (ev.error === "no-speech") say("I didn't hear anything. Tap the yellow button and speak.");
    else if (ev.error === "network") say("Voice needs the internet. You can still use the buttons.");
  };
  rec.onend = () => {
    rec = null; $("talk").classList.remove("listening"); $("talkLabel").textContent = "Tap to talk";
    const h = heard.trim();
    if (h) purpose === "find" ? startFind(h) : route(h);
  };
  $("talk").classList.add("listening");
  $("talkLabel").textContent = purpose === "find" ? "Say the object…" : "Listening… tap to stop";
  beep(1000, 60, 0.2); buzz(30);
  if (purpose === "find") say("What should I find?", { note: "Say an object, like bottle or chair" });
  // start after the prompt so it isn't transcribed
  setTimeout(() => { try { rec && rec.start(); } catch (_) {} }, purpose === "find" ? 1300 : 150);
}

// ---------------------------------------------------------------- wiring
$("startBtn").addEventListener("click", start);
$("talk").addEventListener("click", () => listen("command"));
$("say").addEventListener("click", () => lastSaid && say(lastSaid));
$("bDescribe").addEventListener("click", () => { buzz(20); describe(); });
$("bRead").addEventListener("click", () => { buzz(20); readText(); });
$("bFind").addEventListener("click", () => { buzz(20); mode === "find" ? setMode("idle") : listen("find"); });
$("bExplore").addEventListener("click", () => { buzz(20); setMode(mode === "explore" ? "idle" : "explore"); });
$("bWalk").addEventListener("click", () => { buzz(20); setMode(mode === "walk" ? "idle" : "walk"); });
$("bTorch").addEventListener("click", () => { buzz(20); setTorch(!torchOn); });
setStatus("Tap start");
