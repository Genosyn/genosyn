import { Router } from "express";
import { createOauthConnection } from "../services/integrations.js";
import { finishOauth, resolveOauthState } from "../services/oauth.js";
import { recordAudit } from "../services/audit.js";

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
  const app = String(req.params.app ?? "");
  if (app !== "google") {
    return renderClose(res, {
      ok: false,
      title: "Unknown OAuth provider",
      detail: `"${app}" is not recognised.`,
    });
  }
  const rawState = String(req.query.state ?? "");
  const rawCode = String(req.query.code ?? "");
  const rawError = String(req.query.error ?? "");

  if (rawError) {
    return renderClose(res, {
      ok: false,
      title: "Authorisation cancelled",
      detail: `${rawError}. Close this window and try again.`,
    });
  }
  if (!rawState || !rawCode) {
    return renderClose(res, {
      ok: false,
      title: "OAuth callback missing state or code",
      detail: "Close this window and start the connection again.",
    });
  }

  const state = resolveOauthState(rawState);
  if (!state) {
    return renderClose(res, {
      ok: false,
      title: "OAuth session expired",
      detail:
        "The connection handshake took too long or was restarted. Close this window and try again.",
    });
  }

  try {
    const finished = await finishOauth({ app: "google", code: rawCode, state });
    const conn = await createOauthConnection({
      companyId: finished.companyId,
      provider: finished.provider,
      label: finished.label,
      config: finished.config,
      accountHint: finished.accountHint,
    });
    await recordAudit({
      companyId: finished.companyId,
      actorUserId: state.userId,
      action: "connection.create",
      targetType: "connection",
      targetId: conn.id,
      targetLabel: `${conn.provider} · ${conn.label}`,
      metadata: { provider: conn.provider, authMode: "oauth2" },
    });
    return renderClose(res, {
      ok: true,
      title: `Connected ${conn.provider}`,
      detail: `${conn.accountHint} is now available to your team.`,
    });
  } catch (err) {
    return renderClose(res, {
      ok: false,
      title: "Failed to finish OAuth",
      detail: err instanceof Error ? err.message : String(err),
    });
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
  const color = payload.ok ? "#0f766e" : "#b91c1c";
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
  <button onclick="window.close()">Close</button>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({
          source: "genosyn-oauth",
          ok: ${payload.ok ? "true" : "false"},
          title: ${JSON.stringify(payload.title)},
          detail: ${JSON.stringify(payload.detail)},
        }, "*");
      }
    } catch (_e) { /* no-op */ }
    setTimeout(() => { try { window.close(); } catch (_e) {} }, 1500);
  </script>
</body></html>`;
  res.status(payload.ok ? 200 : 400).type("html").send(body);
}
