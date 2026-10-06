import { Router } from "express";
import { finishOauth, resolveOauthState, type OauthApp } from "../services/oauth.js";
import { completeOauth } from "../services/completeOauth.js";
import { completeHostedReturn, HostedReturnOriginError } from "../services/hostedOauth.js";
import { oauthAuthorizationFailure } from "../services/oauthErrors.js";
import { z } from "zod";
import crypto from "node:crypto";

const OAUTH_APPS: ReadonlySet<OauthApp> = new Set<OauthApp>([
  "google",
  "x",
  "github",
  "reddit",
  "linkedin",
  "microsoft",
]);

function isOauthApp(s: string): s is OauthApp {
  return OAUTH_APPS.has(s as OauthApp);
}

/**
 * Public OAuth callback surface — must be mounted outside the session /
 * requireAuth middleware because Google redirects the browser here
 * *without* our session cookie (the cross-site redirect from
 * accounts.google.com drops first-party cookies on some platforms).
 *
 * Trust comes from the `state` token we minted when the user clicked
 * "Connect Gmail" — it resolves to the {companyId, userId, provider, label}
 * that was authorised and is single-use. If a state is missing / expired
 * / replayed, we redirect to a minimal HTML page explaining what to do.
 *
 * Mounted at `/api/integrations/oauth/callback`.
 */
export const integrationsOauthRouter = Router();

integrationsOauthRouter.get("/callback/:app", async (req, res) => {
  const parsed = z.object({
    app: z.string().min(1).max(32),
    state: z.string().max(512).optional(),
    code: z.string().max(8192).optional(),
    error: z.string().max(512).optional(),
    error_description: z.string().max(2000).optional(),
  }).safeParse({ ...req.query, app: req.params.app });
  if (!parsed.success || !isOauthApp(parsed.data.app)) {
    return renderClose(res, {
      ok: false,
      title: "Invalid OAuth callback",
      detail: "Close this window and start the connection again.",
    });
  }
  const { app, state: rawState, code: rawCode, error: rawError, error_description: rawErrorDescription } = parsed.data;

  if (rawError) {
    const failure = oauthAuthorizationFailure({
      app,
      error: rawError,
      description: rawErrorDescription ?? "",
    });
    return renderClose(res, {
      ok: false,
      ...failure,
    });
  }
  if (!rawState || !rawCode) {
    return renderClose(res, {
      ok: false,
      title: "OAuth callback missing state or code",
      detail: "Close this window and start the connection again.",
    });
  }

  const state = await resolveOauthState(rawState);
  if (!state) {
    return renderClose(res, {
      ok: false,
      title: "OAuth session expired",
      detail:
        "The connection handshake took too long or was restarted. Close this window and try again.",
    });
  }

  try {
    const finished = await finishOauth({ app, code: rawCode, state });
    const { connection: conn, mailboxAddress: mailbox } = await completeOauth({
      ...finished,
      userId: state.userId,
      existingConnectionId: state.existingConnectionId,
      linkMailbox: state.linkMailbox,
    });
    return renderClose(res, {
      ok: true,
      title: state.existingConnectionId
        ? `Reconnected ${conn.provider}`
        : `Connected ${conn.provider}`,
      detail: mailbox
        ? `${mailbox} is connected and importing now.`
        : `${conn.accountHint} is now available to your team.`,
    });
  } catch (err) {
    return renderClose(res, {
      ok: false,
      title: "Failed to finish OAuth",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

const hostedReturnSchema = z.union([
  z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      result: z.string().min(1).max(65_600),
    })
    .strict(),
  z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      error: z.string().regex(/^[a-z_]{1,64}$/),
    })
    .strict(),
]);

/**
 * Where Genosyn Connect sends the browser back after a hosted sign-in, with
 * the result in the URL fragment: `#state=…&result=…` or `#state=…&error=…`.
 * A fragment never reaches a server or a proxy log, so this page reads it,
 * removes it from the address bar, and posts it to the route below. The
 * credential inside is encrypted to a key only this server holds.
 */
integrationsOauthRouter.get("/hosted/return", (_req, res) => {
  const scriptNonce = crypto.randomBytes(18).toString("base64");
  const styleNonce = crypto.randomBytes(18).toString("base64");
  const script = `(()=>{const title=document.getElementById("title"),detail=document.getElementById("detail");const show=(ok,heading,text)=>{title.textContent=heading;title.dataset.tone=ok?"ok":"error";detail.textContent=text;};const fragment=new URLSearchParams(window.location.hash.slice(1));history.replaceState(null,"",window.location.pathname);const body={};for(const key of ["state","result","error"]){const value=fragment.get(key);if(value!==null)body[key]=value;}if(!body.state){show(false,"Nothing to finish here","Start connecting again from Genosyn.");return;}fetch(window.location.pathname,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json().catch(()=>null)).then(data=>{if(data&&data.status==="complete"){show(true,"Connected","Genosyn saved the Connection. This window closes on its own.");setTimeout(()=>{try{window.close();}catch(e){}},1200);}else{show(false,"Sign-in could not finish",(data&&(data.detail||data.error))||"Start again from Genosyn.");}}).catch(()=>show(false,"Sign-in could not finish","Genosyn could not be reached. Start again."));})();`;
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Finishing sign-in · Genosyn</title>
<style nonce="${styleNonce}">
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;max-width:480px;margin:0 auto;color:#111}
  h1{font-size:16px;margin:0 0 8px}
  h1[data-tone=ok]{color:#0f766e}
  h1[data-tone=error]{color:#b91c1c}
  p{margin:0 0 16px;color:#334155}
</style></head>
<body>
  <h1 id="title">Finishing sign-in…</h1>
  <p id="detail" role="status" aria-live="polite">Saving your Connection.</p>
  <script nonce="${scriptNonce}">${script}</script>
</body></html>`;
  res
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .set(
      "Content-Security-Policy",
      `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${styleNonce}'`,
    )
    .type("html")
    .send(body);
});

/**
 * Finish a hosted sign-in. Mounted, like the callback above, before the
 * session: the attempt's single-use `state` and a result encrypted to that
 * attempt's own key are the credential. The post must come from this
 * installation's return page, at the origin the sign-in started from.
 */
integrationsOauthRouter.post("/hosted/return", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (req.headers["sec-fetch-site"] === "cross-site") {
    return res.status(403).json({ error: "Cross-origin request rejected" });
  }
  const parsed = hostedReturnSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "This sign-in result is not valid. Start again." });
  }
  try {
    const outcome = await completeHostedReturn({
      ...parsed.data,
      origin: req.headers.origin,
    });
    res.json(outcome);
  } catch (error) {
    if (error instanceof HostedReturnOriginError) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: "Sign-in could not finish. Start again." });
  }
});

/**
 * Render a tiny HTML page that announces the result to the opener window
 * via `postMessage` and then closes itself. The parent tab listens for
 * `{ source: "genosyn-oauth", ... }` messages and refreshes its connection
 * list. If the popup was navigated directly (no opener), the message just
 * sits there harmlessly and the user closes the tab manually.
 */
function renderClose(
  res: import("express").Response,
  payload: { ok: boolean; title: string; detail: string },
): void {
  const safe = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const scriptString = (value: string) => JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const color = payload.ok ? "#0f766e" : "#b91c1c";
  const scriptNonce = crypto.randomBytes(18).toString("base64");
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>${safe(payload.title)}</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       padding:32px;max-width:480px;margin:0 auto;color:#111}
  h1{font-size:16px;margin:0 0 8px;color:${color}}
  p{margin:0 0 16px;color:#334155}
  button{padding:6px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer}
</style></head>
<body>
  <h1>${safe(payload.title)}</h1>
  <p>${safe(payload.detail)}</p>
  <p>You can close this window.</p>
  <button id="close">Close</button>
  <script nonce="${scriptNonce}">
    document.getElementById("close").addEventListener("click", () => window.close());
    try {
      if (window.opener) {
        window.opener.postMessage({
          source: "genosyn-oauth",
          ok: ${payload.ok ? "true" : "false"},
          title: ${scriptString(payload.title)},
          detail: ${scriptString(payload.detail)},
        }, window.location.origin);
      }
    } catch (_e) { /* no-op */ }
    setTimeout(() => { try { window.close(); } catch (_e) {} }, 1500);
  </script>
</body></html>`;
  res
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${scriptNonce}'; style-src 'unsafe-inline'`)
    .status(payload.ok ? 200 : 400)
    .type("html")
    .send(body);
}
