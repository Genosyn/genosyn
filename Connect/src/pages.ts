import type { AccessItem } from "./broker.js";
import type { Protocol } from "./protocol.js";

/**
 * Server-rendered pages. Each is self-contained — no external fonts, scripts
 * or images — and styled and scripted only through a per-response nonce, so
 * the Content-Security-Policy can stay `default-src 'none'`.
 */

export type PageLinks = { privacy: string | null; terms: string | null };

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

/** A JSON string literal that cannot close a script element or break a line. */
export function scriptString(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0f172a"/><circle cx="16" cy="16" r="9" fill="none" stroke="#ffffff" stroke-width="2.4"/></svg>';

const STYLES = `:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--text:#0f172a;--muted:#475569;--subtle:#64748b;--border:#e2e8f0;--accent:#0f172a;--accent-text:#fff;--ok:#0f766e;--err:#b91c1c;--chip:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#020617;--card:#0f172a;--text:#f1f5f9;--muted:#cbd5e1;--subtle:#94a3b8;--border:#1e293b;--accent:#f8fafc;--accent-text:#0f172a;--ok:#2dd4bf;--err:#f87171;--chip:#1e293b}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;padding:48px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;color:var(--muted);margin:0 0 20px}
main{width:100%;max-width:480px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px;box-shadow:0 1px 2px rgba(15,23,42,.05)}
h1{font-size:22px;line-height:1.3;margin:0 0 12px;letter-spacing:-.01em}
p{margin:0 0 14px;color:var(--muted)}
.origin{display:block;margin:0 0 16px;padding:10px 12px;border-radius:10px;background:var(--chip);color:var(--text);font:600 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.access{list-style:none;margin:0 0 18px;padding:0;border:1px solid var(--border);border-radius:12px}
.access li{padding:12px 14px;border-top:1px solid var(--border)}
.access li:first-child{border-top:0}
.access strong{display:block;color:var(--text);font-size:14px;font-weight:600}
.access span{color:var(--subtle);font-size:13px}
.status{font-size:13px;color:var(--subtle);min-height:20px}
.status[data-tone=ok]{color:var(--ok)}
.status[data-tone=error]{color:var(--err)}
button{width:100%;font:inherit;font-weight:600;padding:12px 16px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-text);cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}
button:focus-visible,a:focus-visible{outline:3px solid #94a3b8;outline-offset:3px}
.note{font-size:13px;color:var(--subtle);margin:16px 0 0}
.tone-error h1{color:var(--err)}
footer{margin-top:20px;font-size:12px;color:var(--subtle);display:flex;gap:16px}
footer a{color:inherit}
@media (max-width:520px){body{padding:24px 16px}main{padding:24px}}`;

function renderDocument(args: {
  title: string;
  styleNonce: string;
  body: string;
  links: PageLinks;
  className?: string;
  script?: { nonce: string; source: string };
}): string {
  const footer = [
    args.links.privacy ? `<a href="${escapeHtml(args.links.privacy)}">Privacy</a>` : "",
    args.links.terms ? `<a href="${escapeHtml(args.links.terms)}">Terms</a>` : "",
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(args.title)} · Genosyn Connect</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style nonce="${escapeHtml(args.styleNonce)}">${STYLES}</style></head><body><div class="brand">${LOGO_SVG}<span>Genosyn Connect</span></div><main${args.className ? ` class="${args.className}"` : ""}>${args.body}</main>${footer ? `<footer>${footer}</footer>` : ""}${args.script ? `<script nonce="${escapeHtml(args.script.nonce)}">${args.script.source}</script>` : ""}</body></html>`;
}

/** The interstitial between an installation and the provider's consent screen. */
export function consentPage(args: {
  providerName: string;
  continueLabel: string;
  protocol: Protocol;
  requestId: string;
  browserNonce: string;
  installationOrigin: string;
  access: AccessItem[];
  styleNonce: string;
  scriptNonce: string;
  links: PageLinks;
}): string {
  const title =
    args.access.length === 1 ? `Connect ${args.access[0].label}` : `Connect ${args.providerName}`;
  const access = args.access
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.description)}</span></li>`,
    )
    .join("");
  const body = `<h1>${escapeHtml(title)}</h1><p>Your Genosyn installation at</p><span class="origin">${escapeHtml(args.installationOrigin)}</span><p>is asking to connect your ${escapeHtml(args.providerName)} account.${access ? " It will be able to:" : ""}</p>${access ? `<ul class="access">${access}</ul>` : ""}<p class="status" id="launch-status" role="status" aria-live="polite">Checking that you opened this page from your installation…</p><form method="post" action="${escapeHtml(args.protocol.basePath)}/authorize"><input type="hidden" name="requestId" value="${escapeHtml(args.requestId)}"><input type="hidden" name="csrfToken" value="${escapeHtml(args.browserNonce)}"><input id="browser-proof" type="hidden" name="browserProof" value=""><button id="continue" type="submit" disabled>${escapeHtml(args.continueLabel)}</button></form><p class="note">Genosyn Connect handles sign-in and token renewal for self-hosted installations. Your installation works with ${escapeHtml(args.providerName)} directly: your email, files and other data never pass through this service.</p>`;
  // The opener must be the installation's own page: it alone holds the proof
  // whose hash the installation registered when it started this sign-in.
  const source = `(()=>{const requestId=${scriptString(args.requestId)},origin=${scriptString(args.installationOrigin)},launch=${scriptString(args.protocol.launchMessage)},ready=${scriptString(args.protocol.readyMessage)};const status=document.getElementById("launch-status"),proof=document.getElementById("browser-proof"),button=document.getElementById("continue");const lost=()=>{if(button.disabled){status.textContent="Return to your Genosyn installation and start again from there. Keep its window open while you sign in.";status.dataset.tone="error";}};if(!window.opener){lost();return;}const timer=setTimeout(lost,5000);window.addEventListener("message",event=>{const data=event.data;if(event.source!==window.opener||event.origin!==origin||!data||data.source!==launch||data.requestId!==requestId||typeof data.proof!=="string"||!/^[-A-Za-z0-9._~]{43,128}$/.test(data.proof))return;proof.value=data.proof;button.disabled=false;status.textContent="Opened from your Genosyn installation. Continue only if you meant to connect.";status.dataset.tone="ok";clearTimeout(timer);});window.opener.postMessage({source:ready,requestId},origin);})();`;
  return renderDocument({
    title,
    styleNonce: args.styleNonce,
    body,
    links: args.links,
    script: { nonce: args.scriptNonce, source },
  });
}

/**
 * A failed or expired sign-in, and every other browser-facing error. A sign-in
 * that gets as far as the provider always ends on the installation's own page
 * instead, so this service never shows a success.
 */
export function messagePage(args: {
  title: string;
  detail: string;
  tone: "error" | "info";
  styleNonce: string;
  links: PageLinks;
}): string {
  return renderDocument({
    title: args.title,
    styleNonce: args.styleNonce,
    body: `<h1>${escapeHtml(args.title)}</h1><p>${escapeHtml(args.detail)}</p>`,
    links: args.links,
    className: args.tone === "error" ? "tone-error" : undefined,
  });
}

/** What someone who opens the service's address directly sees. */
export function landingPage(args: {
  providers: Array<{ name: string; products: string[] }>;
  styleNonce: string;
  links: PageLinks;
}): string {
  const offered = args.providers
    .filter((provider) => provider.products.length > 0)
    .map(
      (provider) =>
        `<li><strong>${escapeHtml(provider.name)}</strong><span>${escapeHtml(provider.products.join(", "))}</span></li>`,
    )
    .join("");
  const body = `<h1>Genosyn Connect</h1><p>Genosyn Connect lets self-hosted Genosyn installations connect Integrations without registering their own OAuth apps. There is nothing to do here: start from your installation, under Email or Settings → Integrations.</p>${offered ? `<p>Available here:</p><ul class="access">${offered}</ul>` : "<p>No Integrations are available here yet.</p>"}<p class="note">This service keeps nothing. Each sign-in travels sealed through your browser and comes back to your installation encrypted to its own key, and renewing access stores nothing either. It never sees your email, files or other data.</p>`;
  return renderDocument({
    title: "Genosyn Connect",
    styleNonce: args.styleNonce,
    body,
    links: args.links,
  });
}
