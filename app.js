/* ZoneSpotter
 * Camera -> (AI pose OR movement check) -> zones -> tag sent to micro:bit over Bluetooth UART.
 *
 * Each zone watches for one of two things:
 *   "pose"   - the AI (ml5 MoveNet, many people at once) finds a left or right ankle inside the zone
 *   "motion" - something moves inside the zone (simple frame-to-frame picture difference, no AI)
 *
 * Everything runs in the browser. Zones are saved in this browser's localStorage.
 * Hidden debug mode (skeletons + numbers): add ?debug to the address, press the D key,
 * or tap the "Sending" pill 5 times quickly.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- settings
  const STORAGE_KEY = "zonespotter.zones.v1";
  const DEBUG_KEY = "zonespotter.debug";
  const MAX_ZONES = 12;
  const MAX_TAG_LENGTH = 20;
  const CLEAR_WORD = "CLEAR";     // sent when every zone is empty (reserved, kids cannot use it as a tag)
  const COLORS = ["#ff6b6b", "#ffd23f", "#3ddc97", "#4cc9f0", "#8e6bff", "#ff9f43", "#f368e0", "#a3e635"];
  const MIN_ZONE_SIZE = 0.04;     // smallest zone, as a fraction of the picture

  // AI pose zones
  const ANKLE_CONFIDENCE = 0.2;   // ignore ankles the AI is less sure about than this (0 to 1)
  const MIN_POSE_SCORE = 0.2;     // ignore whole people the AI is less sure about than this
  const MODEL_MAX_DIMENSION = 256; // bigger (320, 384) sees smaller / farther people, but is slower. Multiple of 32.
  const HOLD_MS = 300;            // a feet zone stays "occupied" this long after the AI last saw an ankle in it (stops flicker)
  const STALE_MS = 3000;          // if no fresh result arrives for this long, zones are treated as empty

  // Movement zones
  const MOTION_WIDTH = 160;           // movement is measured on a small copy of the picture (fast on phones)
  const MOTION_INTERVAL_MS = 80;      // about 12 checks per second
  const MOTION_PIXEL_DIFF = 24;       // how much a pixel's brightness must change (0-255) to count as "moved"
  const MOTION_ZONE_FRACTION = 0.02;  // share of a zone's pixels that must move
  const MOTION_MIN_PIXELS = 6;        // ...and at least this many pixels
  const MOTION_GLOBAL_LIMIT = 0.5;    // ignore a frame if more than half of the picture changed (camera shake, light change)
  const MOTION_HOLD_MS = 600;         // a movement zone stays "occupied" this long after the last movement

  const MODES = {
    pose:   { icon: "🦶", name: "Feet" },
    motion: { icon: "🏃", name: "Movement" },
  };

  // micro:bit Bluetooth UART service. The micro:bit numbers its two characteristics the other way round from
  // the Nordic standard: we WRITE to 6e400003 (the micro:bit receives); 6e400002 is the one it sends on.
  const UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const UART_WRITE = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

  // Body-point connections for the debug skeleton
  const SKELETON = [
    ["nose", "left_eye"], ["nose", "right_eye"], ["left_eye", "left_ear"], ["right_eye", "right_ear"],
    ["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"],
    ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"],
    ["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"], ["left_hip", "right_hip"],
    ["left_hip", "left_knee"], ["left_knee", "left_ankle"], ["right_hip", "right_knee"], ["right_knee", "right_ankle"],
  ];

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("start"), startBtn: $("startBtn"), startStatus: $("startStatus"),
    main: $("main"), stage: $("stage"), video: $("video"), canvas: $("overlay"),
    btBtn: $("btBtn"), btDot: $("btDot"), btLabel: $("btLabel"),
    flipBtn: $("flipBtn"), fsBtn: $("fsBtn"), clearBtn: $("clearBtn"),
    signalPill: $("signalPill"), signalText: $("signalText"), debugBox: $("debugBox"),
    hint: $("hint"), newZoneBtn: $("newZoneBtn"), chips: $("chips"),
    scrim: $("scrim"), toast: $("toast"),
    nameSheet: $("nameSheet"), nameTitle: $("nameTitle"), tagInput: $("tagInput"),
    tagPreview: $("tagPreview"), tagError: $("tagError"),
    nameSave: $("nameSave"), nameDelete: $("nameDelete"), nameCancel: $("nameCancel"),
    askSheet: $("askSheet"), askTitle: $("askTitle"), askText: $("askText"), askButtons: $("askButtons"),
  };
  const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));
  const ctx = el.canvas.getContext("2d");

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---------------------------------------------------------------- state
  let zones = [];                 // { id, tag, color, mode, x, y, w, h } + runtime { lastSeen, occ, enteredAt, level }
  let poses = [];                 // latest AI results
  let bodyPose = null;
  let stream = null;
  let facing = "environment";
  let running = false;            // detection loop on/off
  let drawMode = false;
  let drawing = null;             // { x0, y0, x1, y1 } while dragging (normalized)
  let pending = null;             // zone rectangle waiting for a name { x, y, w, h }
  let editingId = null;           // zone being changed
  let selectedMode = "pose";      // mode picked in the naming sheet
  let lastMode = "pose";          // remembered so kids can make several zones of the same kind quickly
  let lastSent = null;
  let wakeLock = null;
  let toastTimer = null;

  // AI speed + "can the AI see feet?" bookkeeping
  let detectMs = 0;               // smoothed time one AI check takes
  let detectGapMs = 0;            // smoothed time between two finished AI checks
  let lastDetectDone = 0;
  let lastDetectError = "";       // shown in debug mode so a failing AI explains itself
  let skelDrawn = { lines: 0, points: 0 };
  let startedAt = 0;
  let everSawAnkles = false;
  let lastPeopleAt = -Infinity;
  let aiHint = "";

  let debug = false;
  let debugTaps = [];
  let lastDebugBoxAt = 0;

  // ---------------------------------------------------------------- toast, sheets
  function toast(message, ms = 2600) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function openSheet(sheet) {
    el.scrim.hidden = false;
    sheet.hidden = false;
  }
  function closeSheets() {
    el.scrim.hidden = true;
    el.nameSheet.hidden = true;
    el.askSheet.hidden = true;
  }

  /** Small pop-up with a title, text and buttons: ask({title, text, buttons:[{label, cls, onClick}]}) */
  function ask({ title, text, buttons }) {
    el.askTitle.textContent = title;
    el.askText.textContent = text;
    el.askButtons.textContent = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn " + (b.cls || "btn-plain");
      btn.textContent = b.label;
      btn.addEventListener("click", () => {
        closeSheets();
        if (b.onClick) b.onClick();
      });
      el.askButtons.appendChild(btn);
    }
    openSheet(el.askSheet);
  }

  // ---------------------------------------------------------------- saved zones
  function loadZones() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      zones = list
        .filter((z) => z && typeof z.tag === "string" &&
          [z.x, z.y, z.w, z.h].every((n) => typeof n === "number" && isFinite(n)))
        .slice(0, MAX_ZONES)
        .map((z) => makeZone(z));
    } catch (err) {
      console.warn("Could not read saved zones", err);
    }
  }

  function saveZones() {
    try {
      const plain = zones.map(({ id, tag, color, mode, x, y, w, h }) => ({ id, tag, color, mode, x, y, w, h }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
    } catch (err) {
      console.warn("Could not save zones", err);
    }
  }

  function makeZone(z) {
    return {
      id: z.id || "z" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      tag: z.tag,
      color: z.color || COLORS[0],
      mode: z.mode === "motion" ? "motion" : "pose",   // zones saved by older versions are pose zones
      x: clamp01(z.x), y: clamp01(z.y), w: clamp01(z.w), h: clamp01(z.h),
      lastSeen: -Infinity, occ: false, enteredAt: 0, level: 0,
    };
  }

  function clamp01(n) { return Math.min(1, Math.max(0, n)); }

  function nextColor() {
    const used = new Set(zones.map((z) => z.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[zones.length % COLORS.length];
  }

  // ---------------------------------------------------------------- tags
  /** Make what the kid typed safe for the micro:bit: spaces become _, odd characters are removed. */
  function cleanTag(raw) {
    return raw.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_]/g, "").slice(0, MAX_TAG_LENGTH);
  }

  function tagProblem(tag) {
    if (!tag) return "Type a name first.";
    if (tag.toUpperCase() === CLEAR_WORD) return "CLEAR is a secret word that means all zones are empty. Pick another name.";
    return "";
  }

  // ---------------------------------------------------------------- layout
  const stageSize = { w: 640, h: 480 };

  function layoutStage() {
    const vw = el.video.videoWidth || 640;
    const vh = el.video.videoHeight || 480;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const scale = Math.min(W / vw, H / vh);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    el.stage.style.width = w + "px";
    el.stage.style.height = h + "px";
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stageSize.w = w;
    stageSize.h = h;
  }

  // ---------------------------------------------------------------- camera
  async function startCamera() {
    stopCamera();
    const constraints = {
      audio: false,
      video: {
        facingMode: facing === "user" ? "user" : { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    if (el.video.readyState < 2) {
      await new Promise((resolve) => el.video.addEventListener("loadeddata", resolve, { once: true }));
    }
    layoutStage();
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  async function showFlipIfUseful() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      el.flipBtn.hidden = devices.filter((d) => d.kind === "videoinput").length < 2;
    } catch (_) { /* ignore */ }
  }

  async function flipCamera() {
    const previous = facing;
    facing = facing === "user" ? "environment" : "user";
    try {
      await startCamera();
      poses = [];
      motion.prev = null;
    } catch (err) {
      console.warn("Flip failed", err);
      facing = previous;
      toast("Could not switch the camera.");
      try { await startCamera(); } catch (_) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- fullscreen + wake lock
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function enterFullscreen() {
    const root = document.documentElement;
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) return false;
    try {
      const result = req.call(root);
      if (result && result.catch) result.catch(() => {});
      return true;
    } catch (_) { return false; }
  }
  function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) { try { const r = exit.call(document); if (r && r.catch) r.catch(() => {}); } catch (_) { /* ignore */ } }
  }
  function toggleFullscreen() {
    if (fullscreenElement()) { exitFullscreen(); return; }
    if (!enterFullscreen()) {
      toast(isIOS
        ? "On iPhone, tap Share, then Add to Home Screen, for full screen."
        : "Full screen is not available in this browser.", 3800);
    }
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } catch (_) { /* not supported or refused */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !wakeLock && !el.main.hidden) requestWakeLock();
  });

  // ---------------------------------------------------------------- AI detection (pose zones)
  /** The AI only needs to run when it can matter: no zones yet (so kids see the dots), a feet zone, or debug mode. */
  function needPose() {
    return debug || zones.length === 0 || zones.some((z) => z.mode === "pose");
  }

  /**
   * ml5 1.4 hands back a Promise of the model (when p5 is not used), older builds hand back the model itself.
   * Awaiting works for both.
   */
  async function resolveModel(created) {
    const model = await created;
    if (model && model.ready) await model.ready;
    if (!model || typeof model.detect !== "function") {
      let version = "unknown version";
      try { version = ml5.version || version; } catch (_) { /* ignore */ }
      throw new Error("ml5 " + version + " cannot detect poses");
    }
    return model;
  }

  async function detectLoop() {
    if (running) return;
    running = true;
    while (running) {
      const v = el.video;
      if (!needPose()) {
        poses = [];
        lastDetectDone = 0;
      } else if (v.readyState >= 2 && v.videoWidth > 0 && !document.hidden) {
        try {
          if (v.width !== v.videoWidth || v.height !== v.videoHeight) {
            // ml5 1.4 scales the keypoints by these attributes (0 when unset, which would put every point at 0,0)
            v.width = v.videoWidth;
            v.height = v.videoHeight;
          }
          const t0 = performance.now();
          const results = await bodyPose.detect(v);
          const t1 = performance.now();
          detectMs = detectMs ? detectMs * 0.8 + (t1 - t0) * 0.2 : (t1 - t0);
          if (lastDetectDone) {
            const gap = t1 - lastDetectDone;
            detectGapMs = detectGapMs ? detectGapMs * 0.8 + gap * 0.2 : gap;
          }
          lastDetectDone = t1;
          poses = results || [];
          markZonesFromPoses(t1);
        } catch (err) {
          console.warn("Detection hiccup", err);
          lastDetectError = String((err && err.message) || err).slice(0, 80);
          poses = [];
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  /** Normalised (0..1) ankle points for every person the AI can see. */
  function anklePoints() {
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    const pts = [];
    if (!vw || !vh) return pts;
    for (const pose of poses) {
      for (const k of pose.keypoints || []) {
        if ((k.name === "left_ankle" || k.name === "right_ankle") && k.confidence > ANKLE_CONFIDENCE) {
          pts.push({ x: k.x / vw, y: k.y / vh });
        }
      }
    }
    return pts;
  }

  function inside(p, z) {
    return p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h;
  }

  function markZonesFromPoses(now) {
    if (poses.length) lastPeopleAt = now;
    const pts = anklePoints();
    if (pts.length) everSawAnkles = true;
    for (const z of zones) {
      if (z.mode === "pose" && pts.some((p) => inside(p, z))) z.lastSeen = now;   // remember when an ankle was last inside
    }
  }

  // ---------------------------------------------------------------- movement detection (movement zones)
  const motion = {
    canvas: document.createElement("canvas"), ctx: null,
    w: 0, h: 0, prev: null, cur: null, changed: null,
    lastAt: 0, global: 0, ms: 0,
  };

  function runMotion(now) {
    const motionZones = zones.filter((z) => z.mode === "motion");
    if (!motionZones.length) { motion.prev = null; return; }
    if (now - motion.lastAt < MOTION_INTERVAL_MS) return;
    const v = el.video;
    if (v.readyState < 2 || !v.videoWidth || document.hidden) return;
    motion.lastAt = now;

    const t0 = performance.now();
    const w = MOTION_WIDTH;
    const h = Math.max(1, Math.round(MOTION_WIDTH * v.videoHeight / v.videoWidth));
    if (!motion.ctx || motion.w !== w || motion.h !== h) {
      motion.canvas.width = w;
      motion.canvas.height = h;
      motion.ctx = motion.canvas.getContext("2d", { willReadFrequently: true });
      motion.w = w; motion.h = h;
      motion.prev = null;
      motion.cur = new Uint8Array(w * h);
      motion.changed = new Uint8Array(w * h);
    }
    motion.ctx.drawImage(v, 0, 0, w, h);
    const data = motion.ctx.getImageData(0, 0, w, h).data;
    const cur = motion.cur;
    for (let i = 0, p = 0; i < cur.length; i++, p += 4) {
      cur[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;   // brightness
    }

    if (motion.prev) {
      const changed = motion.changed;
      let changedAll = 0;
      for (let i = 0; i < cur.length; i++) {
        const d = cur[i] - motion.prev[i];
        const c = (d > MOTION_PIXEL_DIFF || d < -MOTION_PIXEL_DIFF) ? 1 : 0;
        changed[i] = c;
        changedAll += c;
      }
      motion.global = changedAll / cur.length;

      if (motion.global <= MOTION_GLOBAL_LIMIT) {
        for (const z of motionZones) {
          const x0 = Math.floor(z.x * w), x1 = Math.min(w, Math.ceil((z.x + z.w) * w));
          const y0 = Math.floor(z.y * h), y1 = Math.min(h, Math.ceil((z.y + z.h) * h));
          let n = 0, area = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) { area++; n += changed[y * w + x]; }
          }
          z.level = area ? n / area : 0;
          if (n >= Math.max(MOTION_MIN_PIXELS, MOTION_ZONE_FRACTION * area)) z.lastSeen = now;
        }
      }
    }

    // keep this frame to compare with the next one
    const spare = motion.prev;
    motion.prev = cur;
    motion.cur = spare || new Uint8Array(w * h);
    motion.ms = performance.now() - t0;
  }

  // ---------------------------------------------------------------- occupancy + signal
  function holdFor(z) {
    return z.mode === "motion" ? MOTION_HOLD_MS : HOLD_MS;
  }

  /** The moment the newest result for this kind of zone arrived (0 = none yet). */
  function dataTimeFor(z) {
    return z.mode === "motion" ? motion.lastAt : lastDetectDone;
  }

  /**
   * Works out which zones are occupied and tells the micro:bit if that changed.
   * A zone only becomes empty when a FRESH result arrives that no longer shows anything in it
   * (after a short hold). So a slow phone, whose AI answers only once a second, does not flicker.
   */
  let occupancySignature = "";
  function updateOccupancy(now) {
    for (const z of zones) {
      const t = dataTimeFor(z);
      const occ = t > 0 && now - t < STALE_MS && t - z.lastSeen < holdFor(z);
      if (occ && !z.occ) z.enteredAt = now;
      z.occ = occ;
    }
    // Refresh the glowing chips only when something actually changed.
    const signature = zones.map((z) => z.id + (z.occ ? "1" : "0")).join("|");
    if (signature !== occupancySignature) {
      occupancySignature = signature;
      renderChips();
    }
    syncSignal(false);
  }

  /** The tag to send: the most recently entered zone that is still occupied, or CLEAR. */
  function currentTag() {
    let best = null;
    for (const z of zones) {
      if (z.occ && (!best || z.enteredAt > best.enteredAt)) best = z;
    }
    return best ? best.tag : CLEAR_WORD;
  }

  function syncSignal(force) {
    const tag = currentTag();
    if (!force && tag === lastSent) return;
    lastSent = tag;
    el.signalText.textContent = tag;
    el.signalPill.classList.toggle("active", tag !== CLEAR_WORD);
    btWrite(tag);
  }

  // ---------------------------------------------------------------- Bluetooth (micro:bit UART)
  let btDevice = null;
  let btChar = null;
  let btQueue = Promise.resolve();

  function setBtState(state, name) {
    el.btDot.className = "dot" + (state === "connected" ? " connected" : state === "connecting" ? " connecting" : "");
    el.btLabel.textContent = state === "connected" ? (name || "micro:bit") : state === "connecting" ? "Connecting…" : "Connect";
    el.btBtn.setAttribute("aria-label", state === "connected" ? "micro:bit connected" : "Connect micro:bit");
    updateHint();
  }

  function bluetoothHelp() {
    ask({
      title: "Bluetooth needs a different browser",
      text: isIOS
        ? "iPhones and iPads need the free Bluefy app. Open this page in Bluefy to connect your micro:bit."
        : "Please open this page in Chrome or Edge on a laptop, Android phone or Chromebook. Safari and Firefox cannot connect to a micro:bit.",
      buttons: [{ label: "OK", cls: "btn-yellow" }],
    });
  }

  async function connectBluetooth() {
    if (!navigator.bluetooth) { bluetoothHelp(); return; }

    // Already paired earlier in this visit? Try to reconnect without the picker.
    if (btDevice && !btDevice.gatt.connected) {
      try {
        setBtState("connecting");
        await openUart(btDevice);
        return;
      } catch (_) { /* fall through to the picker */ }
    }

    setBtState("connecting");
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "BBC micro:bit" }],
        optionalServices: [UART_SERVICE],
      });
      await openUart(device);
    } catch (err) {
      setBtState("off");
      if (err && err.name === "NotFoundError") return;   // the kid closed the picker
      console.warn("Bluetooth failed", err);
      ask({
        title: "Could not connect",
        text: "Check that your micro:bit is on and running the ZoneSpotter program, then try again. " +
              "If it still does not show up, see the Bluetooth tips in the README.",
        buttons: [{ label: "OK", cls: "btn-yellow" }],
      });
    }
  }

  function describeProps(c) {
    const p = (c && c.properties) || {};
    const names = ["write", "writeWithoutResponse", "notify", "read"].filter((n) => p[n]);
    return names.length ? names.join("+") : "none";
  }

  /** The UART write characteristic is ...0003 on a micro:bit, but trust what the device really offers. */
  async function pickWritableCharacteristic(service) {
    const canWrite = (c) => c && c.properties && (c.properties.write || c.properties.writeWithoutResponse);
    let chosen = null;
    try {
      const all = await service.getCharacteristics();
      chosen = all.find((c) => c.uuid === UART_WRITE && canWrite(c)) || all.find(canWrite) || null;
    } catch (_) { /* fall back below */ }
    if (!chosen) chosen = await service.getCharacteristic(UART_WRITE);
    btStats.props = chosen.uuid ? chosen.uuid.slice(4, 8) + " " + describeProps(chosen) : describeProps(chosen);
    return chosen;
  }

  async function openUart(device) {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UART_SERVICE);
    btChar = await pickWritableCharacteristic(service);
    if (btDevice !== device) {
      device.addEventListener("gattserverdisconnected", onBtDisconnected);
    }
    btDevice = device;
    btQueue = Promise.resolve();
    setBtState("connected", device.name);
    toast("micro:bit connected!");
    syncSignal(true);   // tell it what is happening right now
  }

  function onBtDisconnected() {
    btChar = null;
    setBtState("off");
    toast("micro:bit disconnected. Tap the robot to reconnect.", 3800);
  }

  function disconnectBluetooth() {
    try { if (btDevice && btDevice.gatt.connected) btDevice.gatt.disconnect(); } catch (_) { /* ignore */ }
  }

  const btStats = { sent: 0, last: "", error: "", toastedAt: 0, props: "", via: "" };

  /** Send one line of text. Writes are queued, and split into 20-byte pieces. */
  function btWrite(text) {
    if (!btChar) return;
    const characteristic = btChar;
    const bytes = new TextEncoder().encode(text + "\n");
    btQueue = btQueue.then(async () => {
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.slice(i, i + 20);
        // Try every kind of write the characteristic offers: the plain fire-and-forget one first
        // (what the micro:bit UART normally wants), then the acknowledged one.
        const methods = [];
        if (characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse) {
          methods.push("writeValueWithoutResponse");
        }
        if (characteristic.properties.write === true) {
          methods.push(characteristic.writeValueWithResponse ? "writeValueWithResponse" : "writeValue");
        }
        if (!methods.length) methods.push("writeValue");
        const errors = [];
        let done = false;
        for (const m of methods) {
          try { await characteristic[m](chunk); done = true; btStats.via = m.replace("writeValue", "") || "plain"; break; }
          catch (err) { errors.push(m.replace("writeValue", "w:") + " " + String((err && err.message) || err)); }
        }
        if (!done) throw new Error(errors.join(" | "));
      }
      btStats.sent++;
      btStats.last = text;
      btStats.error = "";
    }).catch((err) => {
      console.warn("Bluetooth write failed", err);
      btStats.error = String((err && err.message) || err).slice(0, 160);
      const now = Date.now();
      if (now - btStats.toastedAt > 10000) {      // tell the kids (but not on every single message)
        btStats.toastedAt = now;
        toast("Could not send to the micro:bit. Tap the robot to reconnect.", 3800);
      }
    });
  }

  el.btBtn.addEventListener("click", () => {
    if (btChar && btDevice && btDevice.gatt.connected) {
      ask({
        title: "micro:bit is connected",
        text: "Do you want to disconnect it?",
        buttons: [
          { label: "Keep connected", cls: "btn-green" },
          { label: "Disconnect", cls: "btn-red", onClick: disconnectBluetooth },
        ],
      });
    } else {
      connectBluetooth();
    }
  });

  // ---------------------------------------------------------------- drawing zones
  function setDrawMode(on) {
    drawMode = on;
    drawing = null;
    el.canvas.classList.toggle("drawing", on);
    el.newZoneBtn.textContent = on ? "✖ Cancel" : "➕ New zone";
    el.newZoneBtn.classList.toggle("cancel", on);
    updateHint();
  }

  function updateHint() {
    let text = "";
    if (drawMode) text = "Drag your finger on the picture to draw a zone.";
    else if (zones.length === 0) text = "Tap “New zone”, then draw a box where feet should be spotted.";
    else if (aiHint) text = aiHint;
    el.hint.textContent = text;
    el.hint.hidden = !text;
  }

  /** Kind help for the "I added a zone and nothing happens" moment: only until the AI has seen feet once. */
  function updateAiHint(now) {
    let text = "";
    const waitingForFeet = !everSawAnkles && !drawMode && zones.some((z) => z.mode === "pose") &&
      now - startedAt > 6000 && el.nameSheet.hidden && el.askSheet.hidden;
    if (waitingForFeet) {
      text = now - lastPeopleAt < 2500
        ? "I can see someone, but not their feet. Step back so the whole body fits in the picture!"
        : "I cannot see anyone yet. Stand where the camera can see your whole body, feet too.";
    }
    if (text !== aiHint) { aiHint = text; updateHint(); }
  }

  function pointerToNorm(ev) {
    const r = el.canvas.getBoundingClientRect();
    return { x: clamp01((ev.clientX - r.left) / r.width), y: clamp01((ev.clientY - r.top) / r.height) };
  }

  el.canvas.addEventListener("pointerdown", (ev) => {
    if (!drawMode || pending) return;
    ev.preventDefault();
    try { el.canvas.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
    const p = pointerToNorm(ev);
    drawing = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  el.canvas.addEventListener("pointermove", (ev) => {
    if (!drawing) return;
    const p = pointerToNorm(ev);
    drawing.x1 = p.x;
    drawing.y1 = p.y;
  });
  const endDrag = (ev) => {
    if (!drawing) return;
    const rect = {
      x: Math.min(drawing.x0, drawing.x1),
      y: Math.min(drawing.y0, drawing.y1),
      w: Math.abs(drawing.x1 - drawing.x0),
      h: Math.abs(drawing.y1 - drawing.y0),
    };
    drawing = null;
    if (ev.type === "pointercancel") return;
    if (rect.w < MIN_ZONE_SIZE || rect.h < MIN_ZONE_SIZE) {
      toast("That box is too small. Drag a bigger one!");
      return;
    }
    openNameSheet({ pending: rect });
  };
  el.canvas.addEventListener("pointerup", endDrag);
  el.canvas.addEventListener("pointercancel", endDrag);

  el.newZoneBtn.addEventListener("click", () => {
    if (drawMode) { setDrawMode(false); return; }
    if (zones.length >= MAX_ZONES) { toast("That is the most zones you can have (" + MAX_ZONES + ")."); return; }
    setDrawMode(true);
  });

  // ---------------------------------------------------------------- naming zones (and choosing what they watch for)
  function refreshModeButtons() {
    for (const b of modeButtons) {
      b.setAttribute("aria-pressed", b.dataset.mode === selectedMode ? "true" : "false");
    }
  }
  for (const b of modeButtons) {
    b.addEventListener("click", () => { selectedMode = b.dataset.mode; refreshModeButtons(); });
  }

  function openNameSheet({ pending: rect, edit }) {
    pending = rect || null;
    editingId = edit ? edit.id : null;
    selectedMode = edit ? edit.mode : lastMode;
    refreshModeButtons();
    el.nameTitle.textContent = edit ? "Change this zone" : "Name your zone";
    el.nameDelete.hidden = !edit;
    el.tagInput.value = edit ? edit.tag : "";
    el.tagError.textContent = "";
    updateTagPreview();
    openSheet(el.nameSheet);
    setTimeout(() => { try { el.tagInput.focus(); el.tagInput.select(); } catch (_) { /* ignore */ } }, 50);
  }

  function updateTagPreview() {
    const tag = cleanTag(el.tagInput.value);
    el.tagPreview.textContent = tag || "…";
  }

  el.tagInput.addEventListener("input", () => {
    const cleaned = cleanTag(el.tagInput.value);
    if (cleaned !== el.tagInput.value) el.tagInput.value = cleaned;
    el.tagError.textContent = "";
    updateTagPreview();
  });

  function closeNameSheet() {
    closeSheets();
    pending = null;
    editingId = null;
  }

  el.nameSheet.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const tag = cleanTag(el.tagInput.value);
    const problem = tagProblem(tag);
    if (problem) { el.tagError.textContent = problem; return; }

    lastMode = selectedMode;
    if (editingId) {
      const z = zones.find((item) => item.id === editingId);
      if (z) {
        if (z.mode !== selectedMode) { z.mode = selectedMode; z.lastSeen = -Infinity; z.occ = false; z.level = 0; }
        z.tag = tag;
      }
      toast("Zone changed: " + tag);
    } else if (pending) {
      zones.push(makeZone({ ...pending, tag, color: nextColor(), mode: selectedMode }));
      toast("Zone “" + tag + "” saved!" + (btChar ? "" : " Tap 🤖 to connect your micro:bit."), btChar ? 2600 : 4500);
    }
    saveZones();
    closeNameSheet();
    setDrawMode(false);
    renderChips();
  });

  el.nameCancel.addEventListener("click", () => {
    closeNameSheet();
    if (!editingId) setDrawMode(false);
  });

  el.nameDelete.addEventListener("click", () => {
    const id = editingId;
    closeNameSheet();
    zones = zones.filter((z) => z.id !== id);
    saveZones();
    renderChips();
    toast("Zone deleted.");
  });

  el.scrim.addEventListener("click", () => {
    if (!el.nameSheet.hidden) { el.nameCancel.click(); return; }
    closeSheets();
  });

  // ---------------------------------------------------------------- chips
  function renderChips() {
    const frag = document.createDocumentFragment();
    for (const z of zones) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (z.occ ? " on" : "");
      chip.style.setProperty("--c", z.color);
      chip.textContent = MODES[z.mode].icon + " " + z.tag;
      chip.setAttribute("aria-label", "Zone " + z.tag + ", watching " + MODES[z.mode].name.toLowerCase() +
        (z.occ ? ", someone is in it" : ""));
      chip.addEventListener("click", () => openNameSheet({ edit: z }));
      frag.appendChild(chip);
    }
    el.chips.replaceChildren(frag);
    updateHint();
  }

  // ---------------------------------------------------------------- clear everything
  el.clearBtn.addEventListener("click", () => {
    if (zones.length === 0) { toast("There are no zones to clear."); return; }
    ask({
      title: "Clear everything?",
      text: "This deletes all " + zones.length + " zone" + (zones.length === 1 ? "" : "s") + " and their names. You cannot undo it.",
      buttons: [
        { label: "Keep my zones", cls: "btn-green" },
        {
          label: "Yes, clear all", cls: "btn-red",
          onClick: () => {
            zones = [];
            saveZones();
            setDrawMode(false);
            renderChips();
            toast("All zones cleared.");
          },
        },
      ],
    });
  });

  el.fsBtn.addEventListener("click", toggleFullscreen);
  el.flipBtn.addEventListener("click", flipCamera);

  // ---------------------------------------------------------------- hidden debug mode
  function setDebug(on, quiet) {
    debug = !!on;
    el.debugBox.hidden = !debug;
    if (!quiet) toast(debug ? "Debug mode ON. Tap the Sending pill 5 times to turn it off." : "Debug mode OFF", 3200);
  }

  function initDebugFromUrlOrStorage() {
    let on = false;
    try { localStorage.removeItem(DEBUG_KEY); } catch (_) { /* ignore */ }   // older versions saved the choice; forget it
    const q = new URLSearchParams(location.search);
    if (q.has("debug")) on = q.get("debug") !== "0";
    setDebug(on, true);
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "d" && ev.key !== "D") return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || el.main.hidden) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    setDebug(!debug);
  });

  el.signalPill.addEventListener("click", () => {
    syncSignal(true);                       // tap = send the current message again (handy to test the micro:bit)
    const now = Date.now();
    debugTaps = debugTaps.filter((t) => now - t < 3000);
    debugTaps.push(now);
    if (debugTaps.length >= 5) { debugTaps = []; setDebug(!debug); }
  });

  /** How sure the AI is about a body point (0 to 1). Tolerates a missing value instead of breaking the drawing. */
  function keyConf(k) {
    const c = k.confidence !== undefined ? k.confidence : k.score;
    return typeof c === "number" && isFinite(c) ? c : 1;
  }

  function drawSkeletons(W, H) {
    skelDrawn = { lines: 0, points: 0 };
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw || !vh) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.font = "700 12px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "middle";
    poses.forEach((pose, i) => {
      try {
        const color = COLORS[i % COLORS.length];
        const byName = {};
        const kps = Array.isArray(pose.keypoints) ? pose.keypoints : [];
        for (const k of kps) if (k && k.name) byName[k.name] = k;
        const pt = (k) => ({ x: (k.x / vw) * W, y: (k.y / vh) * H });
        const ok = (p) => isFinite(p.x) && isFinite(p.y);

        // bones: a dark outline under a bright line, so they show on light and dark pictures alike
        for (const [a, b] of SKELETON) {
          const ka = byName[a], kb = byName[b];
          if (!ka || !kb) continue;
          const ca = keyConf(ka), cb = keyConf(kb);
          if (ca < 0.1 || cb < 0.1) continue;
          const pa = pt(ka), pb = pt(kb);
          if (!ok(pa) || !ok(pb)) continue;
          ctx.globalAlpha = 0.45 + 0.55 * Math.min(1, ca, cb);
          ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
          ctx.lineWidth = 7; ctx.strokeStyle = "#1b1464"; ctx.stroke();
          ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.stroke();
          skelDrawn.lines++;
        }
        ctx.globalAlpha = 1;

        for (const k of kps) {
          if (!k) continue;
          const conf = keyConf(k);
          if (conf < 0.1) continue;
          const p = pt(k);
          if (!ok(p)) continue;
          const isAnkle = k.name === "left_ankle" || k.name === "right_ankle";
          const trusted = conf > ANKLE_CONFIDENCE;
          ctx.beginPath();
          ctx.arc(p.x, p.y, isAnkle ? 8 : 5, 0, Math.PI * 2);
          if (isAnkle && !trusted) {          // an ankle the AI is too unsure about: hollow red ring (it is ignored)
            ctx.lineWidth = 3; ctx.strokeStyle = "#ff4d4d"; ctx.stroke();
          } else {
            ctx.fillStyle = isAnkle ? "#fff" : color;
            ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = "#1b1464"; ctx.stroke();
          }
          skelDrawn.points++;
          if (isAnkle) {
            const label = (k.name === "left_ankle" ? "L " : "R ") + conf.toFixed(2);
            ctx.lineWidth = 3; ctx.strokeStyle = "#1b1464"; ctx.strokeText(label, p.x + 12, p.y);
            ctx.fillStyle = "#fff"; ctx.fillText(label, p.x + 12, p.y);
          }
        }
      } catch (err) {
        console.warn("Skeleton draw hiccup", err);   // one odd person must not hide the others
        ctx.globalAlpha = 1;
      }
    });
    ctx.restore();
  }

  /** Developer contact for the debug panel. Kept scrambled so it is not readable (or searchable) in the page source. */
  const DEV_PARTS = ["2d0707163d051c01170c", "0640341a0f172a300819", "150c1e0f390003"];
  function developerContact() {
    const key = ["Zone", "Spot", "ter!"].join("");
    const hex = DEV_PARTS.join("");
    let out = "";
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key.charCodeAt((i / 2) % key.length));
    }
    return out;
  }

  function aiBackend() {
    let backend = "?", version = "?";
    try { backend = ml5.tf.getBackend() || "?"; } catch (_) { /* ignore */ }
    try { version = ml5.version || "?"; } catch (_) { /* ignore */ }
    return backend + ", ml5 " + version;
  }

  function updateDebugBox(now) {
    if (!debug || now - lastDebugBoxAt < 250) return;
    lastDebugBoxAt = now;
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    const fps = detectGapMs ? (1000 / detectGapMs).toFixed(1) : "-";
    const lines = [
      "DEBUG",
      `developer ${developerContact()}`,
      needPose() ? `AI      ${Math.round(detectMs)} ms  (${fps} per second)` : "AI      paused (only movement zones)",
      `people  ${poses.length}   ankles seen ${anklePoints().length}`,
      `video   ${vw}x${vh}`,
      `drawn   ${skelDrawn.lines} bones, ${skelDrawn.points} points`,
      `engine  ${aiBackend()}`,
      `hold    feet ${HOLD_MS} ms, movement ${MOTION_HOLD_MS} ms`,
    ];
    if (zones.some((z) => z.mode === "motion")) {
      lines.push(`motion  ${Math.round(motion.global * 100)}% of picture changed, ${motion.ms.toFixed(1)} ms`);
    }
    const btOn = !!(btChar && btDevice && btDevice.gatt && btDevice.gatt.connected);
    lines.push(`micro:bit ${btOn ? "connected" : "not connected"}, sent ${btStats.sent}${btStats.last ? ', last "' + btStats.last + '"' : ""}`);
    if (btStats.props) lines.push(`bt char  ${btStats.props}${btStats.via ? ", via " + btStats.via : ""}`);
    if (btStats.error) lines.push(`bt error ${btStats.error}`);
    if (lastDetectError) lines.push(`error   ${lastDetectError}`);
    el.debugBox.textContent = lines.join("\n");
  }

  // ---------------------------------------------------------------- drawing the picture overlay
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  let labelFont = "";
  function drawPill(text, x, y, maxW, color) {
    ctx.save();
    ctx.font = labelFont;
    const tw = Math.min(ctx.measureText(text).width + 16, Math.max(maxW, 60));
    roundRect(x, y, tw, 26, 13);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = "#1b1464";
    ctx.textBaseline = "middle";
    ctx.beginPath();
    ctx.rect(x, y, tw, 26);
    ctx.clip();
    ctx.fillText(text, x + 8, y + 14);
    ctx.restore();
  }

  function drawZoneBox(z, W, H, opts = {}) {
    if (!labelFont) labelFont = "800 16px " + getComputedStyle(document.body).fontFamily;
    const x = z.x * W, y = z.y * H, w = z.w * W, h = z.h * H;
    ctx.save();
    roundRect(x, y, w, h, 12);
    ctx.fillStyle = z.color;
    ctx.globalAlpha = opts.occ ? 0.45 : 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = opts.occ ? 6 : 3;
    ctx.strokeStyle = z.color;
    if (opts.dashed) ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.restore();

    if (z.tag) {
      drawPill(MODES[z.mode].icon + " " + z.tag, x + 6, y + 6, w, z.color);
      if (debug && z.mode === "motion") {
        drawPill("moving " + Math.round(z.level * 100) + "%", x + 6, y + h - 32, w, "#ffffff");
      }
    }
  }

  function render() {
    try {
      const now = performance.now();
      const W = stageSize.w, H = stageSize.h;
      ctx.clearRect(0, 0, W, H);

      runMotion(now);
      updateOccupancy(now);
      updateAiHint(now);

      for (const z of zones) {
        drawZoneBox(z, W, H, { occ: z.occ, dashed: z.id === editingId });
      }

      if (debug) {
        drawSkeletons(W, H);
      } else {
        // what the AI sees: a dot on every ankle
        for (const p of anklePoints()) {
          ctx.beginPath();
          ctx.arc(p.x * W, p.y * H, 8, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = "#1b1464";
          ctx.stroke();
        }
      }

      // zone being dragged, or waiting for its name
      const live = drawing
        ? { x: Math.min(drawing.x0, drawing.x1), y: Math.min(drawing.y0, drawing.y1),
            w: Math.abs(drawing.x1 - drawing.x0), h: Math.abs(drawing.y1 - drawing.y0) }
        : pending;
      if (live) drawZoneBox({ ...live, color: "#ffffff", tag: "", mode: "pose" }, W, H, { dashed: true });

      updateDebugBox(now);
    } catch (err) {
      console.warn("Draw hiccup", err);   // never let one bad frame stop the whole app
    }
    requestAnimationFrame(render);
  }

  // ---------------------------------------------------------------- start up
  function startMessage(text, isError) {
    el.startStatus.textContent = text;
    el.startStatus.classList.toggle("error", !!isError);
  }

  function friendlyCameraError(err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "The camera is blocked. Allow the camera for this page in your browser settings, then reload.";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "No camera was found on this device.";
    }
    if (name === "NotReadableError") {
      return "The camera is being used by another app. Close it and try again.";
    }
    return "Something went wrong starting the camera. Please reload and try again.";
  }

  el.startBtn.addEventListener("click", async () => {
    el.startBtn.disabled = true;
    startMessage("Waking up the camera…");

    // Fullscreen must be requested straight from the tap.
    enterFullscreen();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      startMessage("This page needs a secure (https) connection to use the camera.", true);
      el.startBtn.disabled = false;
      return;
    }

    try {
      await startCamera();
    } catch (err) {
      console.warn("Camera failed", err);
      startMessage(friendlyCameraError(err), true);
      el.startBtn.disabled = false;
      return;
    }

    startMessage("Loading the AI brain… (the first time can take a moment)");
    try {
      if (typeof ml5 === "undefined") throw new Error("ml5 did not load");
      bodyPose = ml5.bodyPose("MoveNet", {
        modelType: "MULTIPOSE_LIGHTNING",
        enableTracking: false,                       // we only need where the ankles are, not who is who
        minPoseScore: MIN_POSE_SCORE,
        multiPoseMaxDimension: MODEL_MAX_DIMENSION,
      });
      bodyPose = await resolveModel(bodyPose);
    } catch (err) {
      console.warn("Model failed", err);
      stopCamera();
      const detail = err && /^ml5/.test(err.message || "") ? " (" + err.message + ")" : "";
      startMessage("The AI brain could not load. Check your internet connection and try again." + detail, true);
      el.startBtn.disabled = false;
      return;
    }

    el.start.hidden = true;
    el.main.hidden = false;
    startedAt = performance.now();
    layoutStage();
    loadZones();
    initDebugFromUrlOrStorage();
    renderChips();
    setBtState("off");
    setDrawMode(false);
    showFlipIfUseful();
    requestWakeLock();
    detectLoop();
    requestAnimationFrame(render);
  });

  window.addEventListener("resize", layoutStage);
  window.addEventListener("orientationchange", () => setTimeout(layoutStage, 200));
  el.video.addEventListener("loadedmetadata", layoutStage);
  el.video.addEventListener("resize", layoutStage);

  // Make the app installable and keep it fast on repeat visits.
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered", err));
  }
})();
