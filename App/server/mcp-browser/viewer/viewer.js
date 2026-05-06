// Genosyn live-browser viewer.
//
// Loads inside the iframe at /api/companies/.../browser-sessions/:sid/view.
// Renders JPEG screencast frames into a <canvas> and forwards mouse/keyboard
// events back to the MCP child via the App's WebSocket fan-out hub when the
// human flips the "Take over" toggle.
//
// The viewer page is auth'd by cookie session (the iframe URL load); the WS
// upgrade is auth'd by a single-use 60-second token minted at start-up.

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
const statusUrl = document.getElementById("status-url");
const statusBadge = document.getElementById("status-badge");
const statusHint = document.getElementById("status-hint");
const takeoverBtn = document.getElementById("takeover");

let ws = null;
let takeover = false;
let viewportWidth = 1280;
let viewportHeight = 800;
let sessionClosed = false;

function setStatus(state, label) {
  statusDot.className = "dot " + state;
  statusText.textContent = label;
}

function setUrl(url, title) {
  if (!url) {
    statusUrl.textContent = "";
    return;
  }
  statusUrl.textContent = title ? title + " — " + url : url;
  statusUrl.title = url;
}

function setHint(text) {
  statusHint.textContent = text || "";
}

function applyViewport(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  viewportWidth = Math.max(1, Math.round(width));
  viewportHeight = Math.max(1, Math.round(height));
  canvas.width = viewportWidth;
  canvas.height = viewportHeight;
}

function showOverlay(title, body) {
  overlay.classList.remove("hidden");
  const h1 = overlay.querySelector("h1");
  const p = overlay.querySelector("p");
  if (h1) h1.textContent = title;
  if (p) p.innerHTML = body;
}

function hideOverlay() {
  overlay.classList.add("hidden");
}

function setTakeover(next) {
  if (sessionClosed) return;
  takeover = next;
  takeoverBtn.classList.toggle("active", takeover);
  takeoverBtn.setAttribute("aria-pressed", takeover ? "true" : "false");
  takeoverBtn.textContent = takeover ? "Release control" : "Take over";
  statusBadge.textContent = takeover ? "Driving" : "Observing";
  statusBadge.classList.toggle("driving", takeover);
  canvas.classList.toggle("takeover", takeover);
  send({ type: "control.takeover", userId: "self", takeover });
  if (takeover) canvas.focus();
}

function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* drop */ }
}

// ---------- frame decode ----------

const decoder = new Image();
let pendingFrameId = null;

decoder.onload = () => {
  if (pendingFrameId === null) return;
  const id = pendingFrameId;
  pendingFrameId = null;
  ctx.drawImage(decoder, 0, 0, canvas.width, canvas.height);
  send({ type: "frame.ack", frameId: id });
};

decoder.onerror = () => {
  // Drop the frame; ack so the MCP keeps going.
  if (pendingFrameId !== null) {
    send({ type: "frame.ack", frameId: pendingFrameId });
    pendingFrameId = null;
  }
};

function paintFrame(frame) {
  hideOverlay();
  if (frame.metadata && Number.isFinite(frame.metadata.deviceWidth)) {
    applyViewport(frame.metadata.deviceWidth, frame.metadata.deviceHeight);
  }
  pendingFrameId = frame.frameId;
  decoder.src = "data:image/jpeg;base64," + frame.data;
}

// ---------- input forwarding ----------

function viewportCoords(ev) {
  const rect = canvas.getBoundingClientRect();
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

canvas.addEventListener("wheel", (ev) => {
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
}, { passive: false });

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

canvas.addEventListener("keydown", (ev) => {
  if (!takeover) return;
  // Let the iframe's parent keep ⌘R / ⌘W / browser shortcuts.
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === "r" || ev.key === "w" || ev.key === "t" || ev.key === "n")) {
    return;
  }
  ev.preventDefault();
  // Always send keyDown (not char). CDP's `char` type only fires keypress/
  // textInput — modern React apps listen for `keydown` to update state, so
  // skipping it leaves the input field's React state empty even though the
  // character appears visually.
  const text = isPrintable(ev.key) && !ev.ctrlKey && !ev.metaKey ? ev.key : undefined;
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

takeoverBtn.addEventListener("click", () => setTakeover(!takeover));

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

let reconnectAttempts = 0;
async function connect() {
  if (sessionClosed) return;
  setStatus("pending", "Connecting…");
  let token;
  try {
    token = await mintToken();
  } catch (err) {
    setStatus("closed", "Auth failed");
    showOverlay("Couldn't authenticate", "Refresh the page to try again. Error: " + (err && err.message ? err.message : err));
    return;
  }
  ws = new WebSocket(wsUrl(token));
  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setStatus("pending", "Live view connected, waiting for the agent…");
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  });
  ws.addEventListener("close", () => {
    if (sessionClosed) return;
    setStatus("closed", "Disconnected");
    if (reconnectAttempts < 3) {
      reconnectAttempts += 1;
      setTimeout(connect, 1000 * reconnectAttempts);
    } else {
      showOverlay("Disconnected", "The live view dropped. Refresh the page to reconnect.");
    }
  });
  ws.addEventListener("error", () => {
    // The close handler does the reconnect dance.
  });
}

function handleServerMessage(msg) {
  if (msg.type === "hello") {
    applyViewport(msg.viewportWidth, msg.viewportHeight);
    setUrl(msg.pageUrl, msg.pageTitle);
    return;
  }
  if (msg.type === "frame") {
    if (statusDot.classList.contains("pending") || statusDot.classList.contains("closed")) {
      setStatus("live", "Live");
    }
    paintFrame(msg);
    return;
  }
  if (msg.type === "nav") {
    setUrl(msg.url, msg.title);
    return;
  }
  if (msg.type === "viewers") {
    setHint(msg.count > 1 ? `${msg.count} viewers` : "");
    return;
  }
  if (msg.type === "closed") {
    sessionClosed = true;
    setStatus("closed", reasonLabel(msg.reason));
    setTakeover(false);
    takeoverBtn.disabled = true;
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

connect();
