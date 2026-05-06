/**
 * Cross-context clipboard helper.
 *
 * `navigator.clipboard.writeText` is gated to *secure contexts* (HTTPS,
 * `localhost`, or `127.0.0.1`). Genosyn ships as a self-hostable container,
 * so a non-trivial slice of users browse it from a LAN IP over plain HTTP
 * (`http://192.168.x.x:8471`, …) where `navigator.clipboard` is undefined
 * and our copy buttons silently throw. This helper falls back to the legacy
 * `document.execCommand("copy")` route via a hidden textarea, which the
 * insecure-context allow-list still permits.
 *
 * Returns `true` on a successful copy, `false` otherwise — callers decide
 * whether to toast / log / surface a manual fallback. We deliberately never
 * throw: a copy button that fails to copy is a UX nuisance, not an exception.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  // Secure-context path — preferred when available.
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path — some browsers expose
    // `navigator.clipboard` but reject writeText on insecure origins.
  }
  // Legacy `execCommand("copy")` route. Works on insecure origins because
  // the user gesture (the click) is still attached to the call stack.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Make it invisible without using `display: none` — selection on a
    // display:none element is rejected by some browsers.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.padding = "0";
    ta.style.border = "0";
    ta.style.outline = "none";
    ta.style.boxShadow = "none";
    ta.style.background = "transparent";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
