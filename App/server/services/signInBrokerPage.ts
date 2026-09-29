import type { SignInProvider } from "./signInBrokerTypes.js";
import type { SignInBrokerProtocol } from "./signInBrokerProtocol.js";

function html(value: string): string {
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

/** A standalone page excludes all install custom JavaScript and token values. */
export function signInPage(
  provider: SignInProvider,
  protocol: SignInBrokerProtocol,
  args: {
    detail?: string;
    scriptNonce?: string;
    form?: { requestId: string; browserNonce: string; installationOrigin: string };
  },
): string {
  const content = args.form
    ? `<p>${html(provider.page.introduction)}</p><p class="origin">${html(args.form.installationOrigin)}</p><p id="launch-status">Checking that you opened this page from your installation…</p><p>${html(provider.page.explanation)}</p><form method="post" action="${html(protocol.basePath)}/authorize"><input type="hidden" name="requestId" value="${html(args.form.requestId)}"><input type="hidden" name="csrfToken" value="${html(args.form.browserNonce)}"><input id="browser-proof" type="hidden" name="browserProof" value=""><button id="continue" type="submit" disabled>${html(provider.page.continueLabel)}</button></form>`
    : `<p>${html(args.detail ?? "Return to your installation to finish connecting.")}</p>`;
  const launch =
    args.form && args.scriptNonce
      ? `<script nonce="${html(args.scriptNonce)}">(()=>{const requestId=${JSON.stringify(args.form.requestId)},origin=${JSON.stringify(args.form.installationOrigin).replace(/</g, "\\u003c")};const status=document.getElementById("launch-status"),proof=document.getElementById("browser-proof"),button=document.getElementById("continue");const timer=setTimeout(()=>{if(button.disabled)status.textContent="Return to your Genosyn installation and open sign-in again. Keep its window open.";},5000);window.addEventListener("message",event=>{const data=event.data;if(event.source!==window.opener||event.origin!==origin||!data||data.source!==${JSON.stringify(protocol.launchMessage)}||data.requestId!==requestId||typeof data.proof!=="string"||!/^[-A-Za-z0-9._~]{43,128}$/.test(data.proof))return;proof.value=data.proof;button.disabled=false;status.textContent="Opened from your Genosyn installation. Continue only if you intended to connect.";clearTimeout(timer);});if(window.opener)window.opener.postMessage({source:${JSON.stringify(protocol.readyMessage)},requestId},origin);})();</script>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(provider.page.title)} · Genosyn</title><style>body{margin:0;background:#f8fafc;color:#0f172a;font:16px/1.55 system-ui,sans-serif}main{box-sizing:border-box;max-width:560px;margin:10vh auto;padding:32px;border:1px solid #e2e8f0;border-radius:16px;background:white}h1{font-size:24px;margin:0 0 20px}p{color:#475569}.origin{overflow-wrap:anywhere;font-weight:600;color:#0f172a}button{font:inherit;padding:12px 20px;border:0;border-radius:8px;background:#0f172a;color:white;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:3px solid #94a3b8;outline-offset:3px}@media(max-width:600px){main{margin:24px 16px;padding:24px}}</style></head><body><main><h1>${html(provider.page.title)}</h1>${content}</main>${launch}</body></html>`;
}
