// Genosyn live-browser viewer.
//
// Loads inside the iframe at /api/companies/.../browser-sessions/:sid/view.
// Renders JPEG screencast frames into a <canvas> and forwards mouse/keyboard
// events back to the App's WebSocket fan-out hub when the human flips the
// "Take over" toggle. Taking over also unlocks the address bar, so a human
// who has control can go where the page needs them to go.
//
// The viewer page is auth'd by cookie session (the iframe URL load); the WS
// upgrade is auth'd by a single-use 60-second token minted at start-up.
//
// ---------------------------------------------------------------------------
// Why the frame pipeline looks like this
//
// The obvious implementation — one <img>, set `.src` per frame, resize the
// canvas from the frame metadata, draw on `onload` — flickers badly, and the
// reason is worth writing down so nobody reintroduces it:
//
//   * Assigning `canvas.width`/`canvas.height` resets the drawing surface and
//     clears it, *even when the value is unchanged*. Doing that once per frame
//     means the canvas spends the whole decode blank, at the screencast frame
//     rate. So: resize only when the size genuinely changes, and only ever in
//     the same synchronous block as the draw that refills it.
//   * Reassigning `.src` while a decode is in flight aborts it, so under load
//     frames were dropped *and* never acked — and CDP will not send another
//     frame until the current one is acked, so the stream stalled and then
//     burst. So: one decode at a time, newest-frame-wins, and every frame is
//     acked exactly once whether it is painted or dropped.
//   * Painting straight out of the decode callback paints more often than the
//     display can show. So: decode eagerly (which keeps acks flowing even in a
//     backgrounded tab), paint on rAF.

const segments = window.location.pathname.split("/").filter(Boolean);
// Path: /api/companies/<cid>/employees/<eid>/browser-sessions/<sid>/view
const cid = segments[2];
const eid = segments[4];
const sid = segments[6];

const baseUrl = `/api/companies/${cid}/employees/${eid}/browser-sessions/${sid}`;

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const overlay = document.getElementById("overlay");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const statusBadge = document.getElementById("status-badge");
const statusHint = document.getElementById("status-hint");
const takeoverBtn = document.getElementById("takeover");
const omnibox = document.getElementById("omnibox");
const urlInput = document.getElementById("url");
const goBtn = document.getElementById("go");
const backBtn = document.getElementById("nav-back");
const forwardBtn = document.getElementById("nav-forward");
const reloadBtn = document.getElementById("nav-reload");
const notice = document.getElementById("notice");

let ws = null;
let takeover = false;
let viewportWidth = 1280;
let viewportHeight = 800;
let sessionClosed = false;
let connectionLabel = "Connecting…";
let pageTitle = "";
let currentUrl = "";
let urlDirty = false;

// ---------- status chrome ----------

function setStatus(state, label) {
  statusDot.className = "dot " + state;
  statusDot.title = label;
  connectionLabel = label;
  renderStatusText();
  canvas.classList.toggle("stale", state !== "live" && paintedOnce);
}

/**
 * The address bar owns the URL now, so this line is free to carry the page
 * title once we are live — which is the thing a watcher actually reads.
 */
function renderStatusText() {
  statusText.textContent =
    connectionLabel === "Live" ? pageTitle || "Live" : connectionLabel;
}

function setHint(text) {
  statusHint.textContent = text || "";
}

let noticeTimer = null;
function showNotice(message) {
  notice.textContent = message;
  notice.classList.add("visible");
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.classList.remove("visible");
    noticeTimer = null;
  }, 7000);
}

function clearNotice() {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  notice.classList.remove("visible");
}

function showOverlay(title, body) {
  overlay.classList.remove("hidden");
  const h1 = overlay.querySelector("h1");
  const p = overlay.querySelector("p");
  if (h1) h1.textContent = title;
  if (p) p.textContent = body;
}

function hideOverlay() {
  overlay.classList.add("hidden");
}

/**
 * The size the *page* thinks it is, in CSS pixels. Used only to scale
 * take-over clicks; the canvas backing store follows the decoded frame
 * instead, so this never touches the drawing surface.
 */
function applyViewport(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === viewportWidth && h === viewportHeight) return;
  viewportWidth = w;
  viewportHeight = h;
}

// ---------- take over ----------

function setTakeover(next) {
  if (sessionClosed && next) return;
  takeover = next;
  takeoverBtn.classList.toggle("active", takeover);
  takeoverBtn.setAttribute("aria-pressed", takeover ? "true" : "false");
  takeoverBtn.textContent = takeover ? "Release control" : "Take over";
  statusBadge.textContent = takeover ? "Driving" : "Observing";
  statusBadge.classList.toggle("driving", takeover);
  canvas.classList.toggle("takeover", takeover);
  syncOmniboxMode();
  send({ type: "control.takeover", userId: "self", takeover });
  if (takeover) {
    canvas.focus();
  } else {
    resetUrlInput();
    clearNotice();
  }
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* drop */
  }
}

// ---------- address bar ----------

function syncOmniboxMode() {
  const enabled = takeover && !sessionClosed;
  urlInput.readOnly = !enabled;
  urlInput.placeholder = enabled ? "Type a URL and press Enter" : "Take over to type an address";
  backBtn.disabled = !enabled;
  forwardBtn.disabled = !enabled;
  reloadBtn.disabled = !enabled;
  goBtn.classList.toggle("visible", enabled && urlDirty);
}

function setUrl(url, title) {
  currentUrl = url || "";
  pageTitle = title || "";
  urlInput.title = pageTitle ? `${pageTitle} — ${currentUrl}` : currentUrl;
  renderStatusText();
  // Never overwrite an address the human is part-way through typing.
  if (urlDirty && document.activeElement === urlInput) return;
  urlInput.value = currentUrl;
  urlDirty = false;
  syncOmniboxMode();
}

function resetUrlInput() {
  urlInput.value = currentUrl;
  urlDirty = false;
  syncOmniboxMode();
}

urlInput.addEventListener("input", () => {
  urlDirty = urlInput.value !== currentUrl;
  syncOmniboxMode();
});

urlInput.addEventListener("focus", () => {
  if (takeover && !urlDirty) urlInput.select();
});

urlInput.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  resetUrlInput();
  urlInput.blur();
  if (takeover) canvas.focus();
});

omnibox.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!takeover || sessionClosed) return;
  const value = urlInput.value.trim();
  if (!value) return;
  clearNotice();
  send({ type: "control.navigate", url: value });
  urlDirty = false;
  syncOmniboxMode();
  urlInput.blur();
  canvas.focus();
});

function sendHistory(action) {
  if (!takeover || sessionClosed) return;
  clearNotice();
  send({ type: "control.history", action });
  canvas.focus();
}

backBtn.addEventListener("click", () => sendHistory("back"));
forwardBtn.addEventListener("click", () => sendHistory("forward"));
reloadBtn.addEventListener("click", () => sendHistory("reload"));
takeoverBtn.addEventListener("click", () => setTakeover(!takeover));

// ---------- frame decode + paint ----------

let decodeBusy = false;
/** Newest frame received while a decode was in flight. Older ones are dropped. */
let nextFrame = null;
/** Decoded and waiting for the next animation frame. */
let queuedBitmap = null;
let paintScheduled = false;
let paintedOnce = false;

function ackFrame(frameId) {
  send({ type: "frame.ack", frameId });
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decodeJpeg(base64) {
  const blob = new Blob([base64ToBytes(base64)], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  // Fallback for engines without createImageBitmap. `decode()` resolves once
  // the bitmap is ready, so the object URL can be released before we draw.
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    if (typeof img.decode === "function") {
      await img.decode();
    } else {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
    }
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function releaseBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
}

function enqueueFrame(frame) {
  if (decodeBusy) {
    // The frame already waiting will never be shown — ack it now so CDP keeps
    // advancing, and keep only the newest.
    if (nextFrame) ackFrame(nextFrame.frameId);
    nextFrame = frame;
    return;
  }
  void decodeLoop(frame);
}

async function decodeLoop(first) {
  decodeBusy = true;
  let frame = first;
  while (frame) {
    const current = frame;
    frame = null;
    try {
      const bitmap = await decodeJpeg(current.data);
      if (current.metadata) {
        applyViewport(current.metadata.deviceWidth, current.metadata.deviceHeight);
      }
      releaseBitmap(queuedBitmap);
      queuedBitmap = bitmap;
      schedulePaint();
    } catch {
      // A corrupt frame is a dropped frame, never a stalled stream.
    }
    ackFrame(current.frameId);
    frame = nextFrame;
    nextFrame = null;
  }
  decodeBusy = false;
}

function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  window.requestAnimationFrame(paint);
}

function paint() {
  paintScheduled = false;
  const bitmap = queuedBitmap;
  if (!bitmap) return;
  queuedBitmap = null;
  const width = bitmap.width;
  const height = bitmap.height;
  // Resizing clears the surface, so it only ever happens immediately before
  // the draw that refills it — and only when the capture size really changed.
  if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  releaseBitmap(bitmap);
  if (!paintedOnce) {
    paintedOnce = true;
    hideOverlay();
  }
}

// ---------- input forwarding ----------

function viewportCoords(ev) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  const x = (ev.clientX - rect.left) * (viewportWidth / rect.width);
  const y = (ev.clientY - rect.top) * (viewportHeight / rect.height);
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
}

function buttonName(num) {
  if (num === 0) return "left";
  if (num === 1) return "middle";
  if (num === 2) return "right";
  return "none";
}

function modifiersFrom(ev) {
  let mods = 0;
  if (ev.altKey) mods |= 1;
  if (ev.ctrlKey) mods |= 2;
  if (ev.metaKey) mods |= 4;
  if (ev.shiftKey) mods |= 8;
  return mods;
}

let lastMove = 0;
canvas.addEventListener("mousemove", (ev) => {
  if (!takeover) return;
  const now = performance.now();
  if (now - lastMove < 16) return; // ~60Hz cap
  lastMove = now;
  const { x, y } = viewportCoords(ev);
  send({
    type: "input.mouse",
    action: "mouseMoved",
    x,
    y,
    button: ev.buttons & 1 ? "left" : ev.buttons & 2 ? "right" : ev.buttons & 4 ? "middle" : "none",
    buttons: ev.buttons,
    modifiers: modifiersFrom(ev),
  });
});

canvas.addEventListener("mousedown", (ev) => {
  if (!takeover) return;
  ev.preventDefault();
  canvas.focus();
  const { x, y } = viewportCoords(ev);
  send({
    type: "input.mouse",
    action: "mousePressed",
    x,
    y,
    button: buttonName(ev.button),
    buttons: ev.buttons,
    clickCount: ev.detail || 1,
    modifiers: modifiersFrom(ev),
  });
});

canvas.addEventListener("mouseup", (ev) => {
  if (!takeover) return;
  ev.preventDefault();
  const { x, y } = viewportCoords(ev);
  send({
    type: "input.mouse",
    action: "mouseReleased",
    x,
    y,
    button: buttonName(ev.button),
    buttons: ev.buttons,
    clickCount: ev.detail || 1,
    modifiers: modifiersFrom(ev),
  });
});

canvas.addEventListener("contextmenu", (ev) => {
  if (takeover) ev.preventDefault();
});

canvas.addEventListener(
  "wheel",
  (ev) => {
    if (!takeover) return;
    ev.preventDefault();
    const { x, y } = viewportCoords(ev);
    send({
      type: "input.mouse",
      action: "mouseWheel",
      x,
      y,
      deltaX: ev.deltaX,
      deltaY: ev.deltaY,
      buttons: ev.buttons,
      modifiers: modifiersFrom(ev),
    });
  },
  { passive: false },
);

function isPrintable(key) {
  return typeof key === "string" && key.length === 1;
}

// CDP's Input.dispatchKeyEvent requires windowsVirtualKeyCode for non-character
// keys (Backspace, Tab, Enter, Arrows, modifiers, …) to actually trigger their
// default action inside Chromium. Browsers still populate `ev.keyCode` for
// every key event, and for the keys we care about it matches the Windows VK
// code 1:1, so we just forward it.
function virtualKeyCode(ev) {
  return typeof ev.keyCode === "number" && ev.keyCode > 0 ? ev.keyCode : undefined;
}

// Some special keys still need a `text` payload on keyDown for their
// default action to fire — Chromium triggers implicit form submission off
// the keypress event (charCode 13), and CDP only emits keypress when
// `text` is present. Without `\r` here, Enter dispatches a keydown that
// the page sees but never submits the form. Same for Tab. Modifier-held
// variants (Cmd+Enter etc.) skip the text so onKeyDown shortcut handlers
// fire without a stray textInput.
function specialKeyText(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return undefined;
  if (ev.key === "Enter") return "\r";
  if (ev.key === "Tab") return "\t";
  return undefined;
}

canvas.addEventListener("keydown", (ev) => {
  if (!takeover) return;
  // ⌘L / Ctrl+L focuses the address bar, exactly as it would in a real browser.
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "l") {
    ev.preventDefault();
    urlInput.focus();
    urlInput.select();
    return;
  }
  // Let the iframe's parent keep ⌘R / ⌘W / browser shortcuts.
  if (
    (ev.metaKey || ev.ctrlKey) &&
    (ev.key === "r" || ev.key === "w" || ev.key === "t" || ev.key === "n")
  ) {
    return;
  }
  ev.preventDefault();
  // Always send keyDown (not char). CDP's `char` type only fires keypress/
  // textInput — modern React apps listen for `keydown` to update state, so
  // skipping it leaves the input field's React state empty even though the
  // character appears visually.
  const printableText = isPrintable(ev.key) && !ev.ctrlKey && !ev.metaKey ? ev.key : undefined;
  const text = printableText ?? specialKeyText(ev);
  send({
    type: "input.key",
    action: "keyDown",
    key: ev.key,
    code: ev.code,
    text,
    modifiers: modifiersFrom(ev),
    windowsVirtualKeyCode: virtualKeyCode(ev),
  });
});

canvas.addEventListener("keyup", (ev) => {
  if (!takeover) return;
  ev.preventDefault();
  send({
    type: "input.key",
    action: "keyUp",
    key: ev.key,
    code: ev.code,
    modifiers: modifiersFrom(ev),
    windowsVirtualKeyCode: virtualKeyCode(ev),
  });
});

// ---------- WS lifecycle ----------

async function mintToken() {
  const r = await fetch(baseUrl + "/ws-token", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`ws-token ${r.status}`);
  const j = await r.json();
  return j.token;
}

function wsUrl(token) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${baseUrl}/ws?token=${encodeURIComponent(token)}`;
}

/**
 * Reconnect forever with a capped backoff rather than giving up after three
 * tries and telling the human to refresh a frame they cannot easily reload.
 * An App restart mid-session is routine; the viewer should simply come back.
 * Retries pause while the tab is hidden — nobody is watching, and a token mint
 * per attempt against a sleeping tab is pure waste.
 */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
let reconnectAttempts = 0;
let reconnectTimer = null;
let connecting = false;

function scheduleReconnect() {
  if (sessionClosed || reconnectTimer || connecting) return;
  // Nobody is watching a hidden tab, and a token mint per attempt against one
  // is pure waste. The visibility listener picks it back up. Only *retries*
  // are gated: the first connect always runs, because an iframe can report
  // hidden while it is perfectly well rendered.
  if (document.visibilityState === "hidden") return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect() {
  if (sessionClosed || connecting) return;
  connecting = true;
  if (!paintedOnce) setStatus("pending", "Connecting…");
  else setStatus("pending", "Reconnecting…");
  let token;
  try {
    token = await mintToken();
  } catch (err) {
    connecting = false;
    setStatus("closed", "Reconnecting…");
    if (reconnectAttempts >= 3) {
      showNotice(
        "Can't reach the live view — retrying. " + (err && err.message ? err.message : ""),
      );
    }
    scheduleReconnect();
    return;
  }

  const socket = new WebSocket(wsUrl(token));
  ws = socket;
  socket.addEventListener("open", () => {
    connecting = false;
    reconnectAttempts = 0;
    clearNotice();
    // A reconnect replays the last frame, and the canvas still holds it — so
    // come straight back as live rather than dimming a picture that is about
    // to be refreshed.
    if (paintedOnce) setStatus("live", "Live");
    else setStatus("pending", "Waiting for the agent…");
    // The hub tracks take-over per socket, so a reconnect starts as an
    // observer on the server. Re-assert it rather than showing a Driving badge
    // over a session we are no longer driving.
    if (takeover) send({ type: "control.takeover", userId: "self", takeover: true });
  });
  socket.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });
  socket.addEventListener("close", () => {
    if (ws === socket) ws = null;
    connecting = false;
    if (sessionClosed) return;
    setStatus("closed", "Reconnecting…");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    // The close handler does the reconnect dance.
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (sessionClosed || ws || connecting) return;
  reconnectAttempts = 0;
  void connect();
});

function handleServerMessage(msg) {
  if (msg.type === "hello") {
    applyViewport(msg.viewportWidth, msg.viewportHeight);
    setUrl(msg.pageUrl, msg.pageTitle);
    return;
  }
  if (msg.type === "frame") {
    if (connectionLabel !== "Live") setStatus("live", "Live");
    enqueueFrame(msg);
    return;
  }
  if (msg.type === "nav") {
    setUrl(msg.url, msg.title);
    return;
  }
  if (msg.type === "nav.error") {
    showNotice(msg.message);
    return;
  }
  if (msg.type === "viewport.set") {
    applyViewport(msg.width, msg.height);
    return;
  }
  if (msg.type === "viewers") {
    setHint(msg.count > 1 ? `${msg.count} watching` : "");
    return;
  }
  if (msg.type === "closed") {
    sessionClosed = true;
    if (takeover) setTakeover(false);
    setStatus("closed", reasonLabel(msg.reason));
    takeoverBtn.disabled = true;
    syncOmniboxMode();
    showOverlay("Session ended", explainClose(msg.reason));
    return;
  }
}

function reasonLabel(reason) {
  if (reason === "idle") return "Closed (idle)";
  if (reason === "shutdown") return "Closed";
  if (reason === "manual") return "Closed (you)";
  if (reason === "error") return "Closed (error)";
  return "Closed";
}

function explainClose(reason) {
  if (reason === "idle") return "The browser shut down after 5 minutes without a tool call.";
  if (reason === "manual") return "You closed this session from the chat panel.";
  if (reason === "error") return "The browser hit a fatal error. Check the run logs for details.";
  return "The agent finished or the session was closed.";
}

syncOmniboxMode();
connect();
