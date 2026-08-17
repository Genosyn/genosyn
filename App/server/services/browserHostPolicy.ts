/**
 * Host allow-list policy for anything that drives a browser session.
 *
 * This used to live inside `routes/browserRpc.ts`, where only the model's
 * `browser_open` could reach it. Take-over navigation (the live viewer's
 * address bar) has to answer to exactly the same lists, and a route file is
 * the wrong place for a rule two subsystems share.
 */

export function parseAllowList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/**
 * Allow-list matching rules (documented in the UI hint and the Browser docs
 * page — keep all three in sync). A bare host is an EXACT match so an
 * operator can pin one host precisely; use the `*.` form for subdomains:
 *   - `mail.google.com` → that exact host, and nothing else
 *   - `*.example.com`   → the apex `example.com` and every subdomain
 *   - `app.*.example.com` → a general glob, matched label-safely (each `*`
 *                           spans one label, never a dot)
 */
export function hostMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.includes("*")) {
    return h === p;
  }
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    if (h === suffix) return true;
    if (h.endsWith("." + suffix)) return true;
    return false;
  }
  // General glob. `*` matches within a single DNS label only — it must not
  // cross a dot, or `example.*` would admit `example.attacker.com`. Escaping
  // every metachar first also keeps the pattern ReDoS-free.
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
  return new RegExp(`^${escaped}$`).test(h);
}

export function urlAllowed(
  url: string,
  allowList: string[],
): { ok: true } | { ok: false; reason: string } {
  if (allowList.length === 0) return { ok: true };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: "URL is not parseable" };
  }
  for (const pattern of allowList) {
    if (hostMatches(host, pattern)) return { ok: true };
  }
  return {
    ok: false,
    reason: `Host \`${host}\` is not in the allow list. Allowed: ${allowList.join(", ")}`,
  };
}

/**
 * Turn whatever a human typed into the live viewer's address bar into an
 * absolute http(s) URL, or explain why it isn't one.
 *
 * Deliberately not a search box: a bare word with no dot is a typo far more
 * often than it is an intent to search, and quietly handing the employee's
 * signed-in browser to a search engine is not a guess worth making. `about:`,
 * `file:`, `javascript:` and friends are refused outright — the address bar
 * drives a browser that holds the employee's cookies, and those schemes reach
 * past every check that follows.
 */
export function normalizeViewerNavigationUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "Type a URL first." };
  if (trimmed.length > 2048) return { ok: false, reason: "That URL is too long." };
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "That isn't a URL Genosyn can open." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http:// and https:// addresses can be opened here." };
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    return { ok: false, reason: "That isn't a URL Genosyn can open." };
  }
  return { ok: true, url: parsed.toString() };
}
