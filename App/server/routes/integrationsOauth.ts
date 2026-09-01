import { Router } from "express";
import { createOauthConnection, updateOauthConnectionConfig } from "../services/integrations.js";
import { finishOauth, resolveOauthState, type OauthApp } from "../services/oauth.js";
import { recordAudit } from "../services/audit.js";
import { createMailAccount } from "../services/mail/accounts.js";
import { queueAccountSync } from "../services/mail/sync.js";
import { oauthAuthorizationFailure } from "../services/oauthErrors.js";
import { AppDataSource } from "../db/datasource.js";
import { MailAccount } from "../db/entities/MailAccount.js";

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
  const app = String(req.params.app ?? "");
  if (!isOauthApp(app)) {
    return renderClose(res, {
      ok: false,
      title: "Unknown OAuth provider",
      detail: `"${app}" is not recognised.`,
    });
  }
  const rawState = String(req.query.state ?? "");
  const rawCode = String(req.query.code ?? "");
  const rawError = String(req.query.error ?? "");
  const rawErrorDescription = String(req.query.error_description ?? "");

  if (rawError) {
    const failure = oauthAuthorizationFailure({
      app,
      error: rawError,
      description: rawErrorDescription,
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
    const conn = state.existingConnectionId
      ? await updateOauthConnectionConfig({
          companyId: finished.companyId,
          connectionId: state.existingConnectionId,
          config: finished.config,
          accountHint: finished.accountHint,
        })
      : await createOauthConnection({
          companyId: finished.companyId,
          provider: finished.provider,
          label: finished.label,
          config: finished.config,
          accountHint: finished.accountHint,
        });
    if (!conn) {
      return renderClose(res, {
        ok: false,
        title: "Connection no longer exists",
        detail:
          "The connection you were reconnecting was deleted while you were authorising. Close this window and start again.",
      });
    }
    await recordAudit({
      companyId: finished.companyId,
      actorUserId: state.userId,
      action: state.existingConnectionId ? "connection.reconnect" : "connection.create",
      targetType: "connection",
      targetId: conn.id,
      targetLabel: `${conn.provider} · ${conn.label}`,
      metadata: { provider: conn.provider, authMode: "oauth2" },
    });
    const mailbox = state.linkMailbox
      ? await linkMailbox({
          companyId: finished.companyId,
          connectionId: conn.id,
          userId: state.userId,
        })
      : null;
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

/**
 * Finish the job the person actually asked for.
 *
 * When the handshake started in the Email section, consent was the last thing
 * standing between them and a working mailbox — so create it here rather than
 * sending them back to hunt for a Connect button. A failure is deliberately
 * swallowed into `null`: the Connection is real and useful either way, the
 * mailbox step is retryable from the Email page, and a red popup would be a
 * worse answer than "connected" for something that did connect.
 */
async function linkMailbox(args: {
  companyId: string;
  connectionId: string;
  userId: string;
}): Promise<string | null> {
  try {
    const existing = await AppDataSource.getRepository(MailAccount).findOneBy({
      connectionId: args.connectionId,
    });
    if (existing) return existing.address;
    const account = await createMailAccount({
      companyId: args.companyId,
      connectionId: args.connectionId,
      createdByUserId: args.userId,
    });
    await recordAudit({
      companyId: args.companyId,
      actorUserId: args.userId,
      action: "mail.account.connect",
      targetType: "mail_account",
      targetId: account.id,
      targetLabel: account.address,
      metadata: { provider: account.provider, via: "oauth" },
    });
    void queueAccountSync(account.id).catch(() => {});
    return account.address;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[oauth] connected ${args.connectionId} but could not link a mailbox: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

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
  res
    .status(payload.ok ? 200 : 400)
    .type("html")
    .send(body);
}
