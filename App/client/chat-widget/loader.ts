import type {
  ChatFrameMessage,
  ChatHostMessage,
  SUPPORT_CHAT_POST_SOURCE,
} from "../../shared/supportChat";

/**
 * The script a company puts on its own site. It draws a launcher and opens the Chat
 * widget in a frame on this install: the page around it never holds a visitor's token
 * or a word of their conversation. All it learns from the frame is that a chat started
 * and how many replies wait, and all it says back is whether the panel is showing.
 *
 * It runs as a plain `<script>` on someone else's page, so it imports nothing at
 * runtime (`loader.test.ts` holds it to that: a shared chunk would be a broken import
 * there), keeps everything inside this function, and styles through the CSS object
 * model, which a strict `style-src` on the host page leaves alone. A visitor who never
 * opens the chat downloads this file and nothing else.
 */
(() => {
  const SOURCE: typeof SUPPORT_CHAT_POST_SOURCE = "genosyn-support-chat";
  const script = document.currentScript as HTMLScriptElement | null;
  const widgetKey = script?.dataset.widgetKey ?? "";
  if (!script || !/^[A-Za-z0-9_-]{22}$/.test(widgetKey)) return;
  const origin = new URL(script.src).origin;
  const startedKey = `genosyn-support-chat:${widgetKey}:started`;
  const ACCENT = "#4f46e5";
  const SVG = "http://www.w3.org/2000/svg";

  const host = document.createElement("div");
  host.setAttribute("data-genosyn-support-chat", "");
  const root = host.attachShadow({ mode: "open" });

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open chat");
  launcher.setAttribute("aria-expanded", "false");
  Object.assign(launcher.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    width: "56px",
    height: "56px",
    padding: "0",
    border: "0",
    borderRadius: "9999px",
    background: ACCENT,
    color: "#ffffff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 14px rgba(15, 23, 42, 0.25)",
    zIndex: "2147483000",
  });

  function icon(paths: string[]): SVGSVGElement {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }
  const chatIcon = icon(["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"]);
  const closeIcon = icon(["M18 6 6 18", "m6 6 12 12"]);
  launcher.appendChild(chatIcon);

  const badge = document.createElement("span");
  Object.assign(badge.style, {
    position: "absolute",
    top: "-2px",
    right: "-2px",
    minWidth: "20px",
    height: "20px",
    padding: "0 5px",
    boxSizing: "border-box",
    borderRadius: "9999px",
    background: "#be123c",
    color: "#ffffff",
    font: "600 12px/20px system-ui, sans-serif",
    textAlign: "center",
    display: "none",
  });
  launcher.appendChild(badge);

  let frame: HTMLIFrameElement | null = null;
  // Until the frame says so it holds an empty page of this site's own, not the widget.
  let frameReady = false;
  let open = false;
  const phone = window.matchMedia("(max-width: 480px)");

  function placeFrame(): void {
    if (!frame) return;
    const fill = phone.matches;
    Object.assign(frame.style, {
      right: fill ? "0" : "20px",
      bottom: fill ? "0" : "88px",
      width: fill ? "100%" : "380px",
      height: fill ? "100%" : "min(640px, calc(100vh - 110px))",
      borderRadius: fill ? "0" : "16px",
    });
    // A full-screen panel covers the launcher, and has a close button of its own.
    launcher.style.display = fill && open ? "none" : "flex";
  }

  function tellFrame(): void {
    if (!frameReady) return;
    const message: ChatHostMessage = { source: SOURCE, type: open ? "opened" : "closed" };
    frame?.contentWindow?.postMessage(message, origin);
  }

  function ensureFrame(): HTMLIFrameElement {
    if (frame) return frame;
    frame = document.createElement("iframe");
    frame.src = `${origin}/support-chat/${widgetKey}`;
    frame.title = "Chat";
    // Enough to run the chat, and no way to move or script the page around it.
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
    Object.assign(frame.style, {
      position: "fixed",
      border: "0",
      background: "#ffffff",
      boxShadow: "0 12px 40px rgba(15, 23, 42, 0.25)",
      zIndex: "2147483000",
      display: "none",
    });
    root.appendChild(frame);
    placeFrame();
    return frame;
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    const opened = ensureFrame();
    opened.style.display = open ? "block" : "none";
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", open ? "Close chat" : "Open chat");
    launcher.replaceChild(open ? closeIcon : chatIcon, open ? chatIcon : closeIcon);
    placeFrame();
    tellFrame();
    if (open) opened.focus();
    else launcher.focus();
  }

  function setUnread(count: number): void {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.style.display = count > 0 ? "block" : "none";
    launcher.setAttribute(
      "aria-label",
      count > 0 ? `Open chat, ${count} unread` : open ? "Close chat" : "Open chat",
    );
  }

  function remember(started: boolean): void {
    try {
      if (started) window.localStorage.setItem(startedKey, "1");
      else window.localStorage.removeItem(startedKey);
    } catch {
      // Then a returning visitor sees no badge until they open the chat.
    }
  }

  function hasStarted(): boolean {
    try {
      return window.localStorage.getItem(startedKey) === "1";
    } catch {
      return false;
    }
  }

  launcher.addEventListener("click", () => setOpen(!open));
  phone.addEventListener("change", placeFrame);

  window.addEventListener("message", (event: MessageEvent) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    const data = event.data as Partial<ChatFrameMessage> | null;
    if (!data || data.source !== SOURCE) return;
    if (data.type === "ready") {
      frameReady = true;
      tellFrame();
    } else if (data.type === "close") setOpen(false);
    else if (data.type === "started") remember(true);
    else if (data.type === "ended") remember(false);
    else if (data.type === "unread") setUnread(typeof data.count === "number" ? data.count : 0);
  });

  function mount(): void {
    root.appendChild(launcher);
    document.body.appendChild(host);
    // Someone who has been chatting here should see a reply waiting without asking.
    if (hasStarted()) ensureFrame();
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
