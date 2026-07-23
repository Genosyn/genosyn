import { Router, type Request, type Response } from "express";
import { In } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import {
  SequenceEnrollment,
  type EnrollmentStatus,
} from "../db/entities/SequenceEnrollment.js";
import { Suppression } from "../db/entities/Suppression.js";
import { addSuppression } from "../services/mail/suppression.js";
import { recordActivity } from "../services/revenue/activities.js";
import {
  findContactByEmail,
  markContactUnsubscribed,
} from "../services/revenue/contacts.js";
import {
  unsubscribeSecret,
  verifyUnsubscribeToken,
} from "../services/revenue/unsubscribeToken.js";

/**
 * The public unsubscribe endpoint. Mounted at the app **root**, not under
 * `/api`, and deliberately outside every auth, session and origin check:
 *
 *   POST /u/:token — RFC 8058 one-click. Gmail's and Yahoo's servers fetch this
 *                    themselves, with no cookie, no CSRF token, no Origin
 *                    header, no JavaScript, and no human present.
 *   GET  /u/:token — the same effect for a person who clicked the footer link,
 *                    followed by a page telling them it worked.
 *
 * Everything that makes this endpoint unusual follows from *who* reaches it: a
 * stranger, from a mail client, potentially years after the message was sent.
 *
 * - **The token is the whole credential.** Nothing rides in the query string —
 *   not the address, not the company id, not a secret. Query strings end up in
 *   proxy logs, browser history and `Referer` headers; the signed path segment
 *   at least stays out of `Referer` once we send `Referrer-Policy: no-referrer`.
 * - **Idempotent by construction.** Gmail POSTs the moment the user presses its
 *   native Unsubscribe button, and the user then often clicks the link in the
 *   footer too. Both must succeed. Every write below is either an upsert or a
 *   filtered update, and the timeline Activity is written only on the
 *   transition, so the second request changes nothing and still renders the
 *   confirmation.
 * - **A bad token leaks nothing.** Invalid, tampered, truncated, and
 *   well-formed-but-unknown all render the identical neutral page. If the
 *   response differed by whether the address, contact or company existed, this
 *   endpoint would be an unauthenticated existence oracle over every mailbox
 *   the installation has ever touched.
 * - **Nothing throws.** Express 4 does not catch a rejected promise from an
 *   async handler, and an uncaught rejection takes the process down. Every path
 *   here ends in a response.
 *
 * **The trade-off we accepted:** acting on GET means a corporate link scanner
 * or an aggressive mail-client prefetch can unsubscribe somebody who never
 * clicked. The alternative — a confirmation button — costs real opt-outs from
 * anyone whose client strips forms or JavaScript, and a *missed* unsubscribe is
 * a spam complaint and a compliance breach, while an over-eager one is a row an
 * operator can remove from the suppression list in the UI. We chose the
 * recoverable failure.
 *
 * Mounting notes for `server/index.ts` (not touched by this file): the router
 * must go **before** `requireTrustedOrigin`, because a one-click POST carries no
 * Origin at all, and it needs no body parser — the one-click body
 * (`List-Unsubscribe=One-Click`) is confirmation of intent we already have from
 * the method and path, so we never read it.
 */

export const unsubscribeRouter = Router();

/** Enrolment statuses that would still send. Terminal ones are left alone. */
const LIVE_ENROLLMENT_STATUSES: EnrollmentStatus[] = ["active", "paused"];

const STOPPED_REASON = "Recipient unsubscribed via link";

export type UnsubscribeResult =
  | { outcome: "invalid" }
  | {
      outcome: "unsubscribed";
      companyId: string;
      /** Normalized address, straight out of the signed token. */
      email: string;
      /** The Contact we could resolve, if any. Null is normal and fine. */
      contactId: string | null;
      /** Null when the company row is gone or unreadable — never an error. */
      companyName: string | null;
      /** True when the address was already suppressed before this request. */
      alreadySuppressed: boolean;
      /** Enrolments this request moved to `stopped_unsubscribed`. */
      stoppedEnrollments: number;
    };

/**
 * Do the unsubscribe.
 *
 * Split out from the handlers because both verbs perform exactly the same
 * mutation — the only difference is the page rendered afterwards — and because
 * a function taking a token and returning a value is testable without booting
 * Express.
 *
 * `secret` and `now` are parameters rather than reads of module state so tests
 * can sign their own tokens and assert on timestamps.
 */
export async function applyUnsubscribe(
  token: string | null | undefined,
  secret: string = unsubscribeSecret(),
  now: Date = new Date(),
): Promise<UnsubscribeResult> {
  const payload = verifyUnsubscribeToken(token, secret);
  if (!payload) return { outcome: "invalid" };

  const { companyId, email } = payload;

  // Read before writing so we can tell a first unsubscribe from a repeat. This
  // is the idempotency key for the Activity: without it, Gmail's POST plus the
  // human's click would put the same event on the timeline twice.
  const alreadySuppressed = await AppDataSource.getRepository(Suppression).existsBy({
    companyId,
    email,
  });

  // Resolve the person two independent ways. The id in the token is who we
  // believed we were mailing; the lookup by address is who exists now. They
  // diverge when a Contact was deleted and re-created, or merged. We act on
  // both — leaving a live enrolment attached to a stale id would keep sending.
  const contact = await findContactByEmail(companyId, email);
  const contactIds = [
    ...new Set([payload.contactId, contact?.id ?? null].filter((id): id is string => !!id)),
  ];
  const primaryContactId = contact?.id ?? payload.contactId;

  // The suppression row is the load-bearing write: it is what the send-path
  // gate in `services/mail/suppression.ts` checks, and it works even when no
  // Contact exists. Everything after this is bookkeeping.
  await addSuppression({
    companyId,
    email,
    reason: "unsubscribe",
    source: "unsubscribe-link",
    contactId: primaryContactId,
    // Null on purpose: no operator did this, the recipient did.
    createdById: null,
  });

  for (const id of contactIds) {
    await markContactUnsubscribed(companyId, id, now);
  }

  const stoppedEnrollments = await stopLiveEnrollments(companyId, contactIds);

  if (!alreadySuppressed) {
    await recordActivity(companyId, {
      kind: "unsubscribe",
      subject: `${email} unsubscribed`,
      occurredAt: now,
      contactId: primaryContactId,
      meta: { email, source: "unsubscribe-link", stoppedEnrollments },
    });
  }

  return {
    outcome: "unsubscribed",
    companyId,
    email,
    contactId: primaryContactId,
    companyName: await resolveCompanyName(companyId),
    alreadySuppressed,
    stoppedEnrollments,
  };
}

/**
 * Stop every sequence that would still mail this person.
 *
 * Selects the ids first and updates them by id rather than trusting
 * `UpdateResult.affected`, which is driver-specific — better-sqlite3 and the
 * Postgres driver do not agree on when it is populated, and the count is
 * reported back to the caller.
 */
async function stopLiveEnrollments(
  companyId: string,
  contactIds: string[],
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const repo = AppDataSource.getRepository(SequenceEnrollment);
  const live = await repo.find({
    where: {
      companyId,
      contactId: In(contactIds),
      status: In(LIVE_ENROLLMENT_STATUSES),
    },
    select: { id: true },
  });
  if (live.length === 0) return 0;

  await repo.update(
    { id: In(live.map((row) => row.id)) },
    {
      status: "stopped_unsubscribed",
      stoppedReason: STOPPED_REASON,
      // Clearing this is what actually takes them out of the scheduler's
      // query; the status alone would only stop the next tick from choosing it.
      nextRunAt: null,
    },
  );
  return live.length;
}

/** Best effort. A missing company is not an error on this endpoint. */
async function resolveCompanyName(companyId: string): Promise<string | null> {
  const row = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  return row?.name?.trim() || null;
}

// ───────────────────────────── rendering ─────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * One page shell for all three outcomes.
 *
 * Everything is inlined into the document. This is served to a stranger's
 * browser from a domain they have no relationship with, so a request for an
 * external stylesheet would be both a needless failure mode (broken layout when
 * the asset 404s on a self-hosted install behind a path-rewriting proxy) and a
 * third-party beacon on a compliance page. `color-scheme` plus one media query
 * is the whole dark-mode story.
 */
function renderPage(title: string, heading: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #ffffff; --fg: #16181d; --muted: #5b616e; --line: #e3e6eb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --card: #1c1f25; --fg: #eceef2; --muted: #9aa1ae; --line: #2c313a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         padding: 24px; background: var(--bg); color: var(--fg);
         font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width: 100%; max-width: 460px; background: var(--card); border: 1px solid var(--line);
         border-radius: 12px; padding: 32px; }
  h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 12px; color: var(--muted); }
  p:last-child { margin-bottom: 0; }
  .addr { color: var(--fg); font-weight: 600; word-break: break-all; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
${body}
</main>
</body>
</html>
`;
}

/**
 * The confirmation. Echoing the address back is safe — it came out of a token
 * the recipient was already holding — and it is the only way they can tell
 * which of their mailboxes they just opted out of.
 */
export function renderUnsubscribedPage(result: {
  email: string;
  companyName: string | null;
}): string {
  const sender = result.companyName
    ? `<strong>${escapeHtml(result.companyName)}</strong>`
    : "this sender";
  return renderPage(
    "Unsubscribed",
    "You have been unsubscribed",
    `<p><span class="addr">${escapeHtml(result.email)}</span> has been removed from ${sender}'s mailing list.</p>
<p>You will not receive further marketing email at this address. You can close this page.</p>`,
  );
}

/**
 * Shown for every failed token, without distinction. Says nothing about whether
 * the address, contact or company exists, and offers no retry — there is
 * nothing a visitor could usefully do here, and the honest advice is to use the
 * link in an actual message.
 */
export function renderInvalidPage(): string {
  return renderPage(
    "Link not valid",
    "This link is not valid",
    `<p>This unsubscribe link could not be read. It may have been altered or truncated when your mail client displayed it.</p>
<p>Please use the unsubscribe link in the original message, or reply to it asking to be removed.</p>`,
  );
}

/** Transient failure — deliberately distinct from the invalid-token page. */
export function renderErrorPage(): string {
  return renderPage(
    "Something went wrong",
    "Something went wrong",
    `<p>We could not process this request just now. Please try again in a few minutes.</p>
<p>If it keeps failing, reply to the message you received and ask to be removed.</p>`,
  );
}

// ───────────────────────────── handlers ─────────────────────────────

function sendHtml(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      // The token is the credential and it lives in the path. Never let it
      // reach a third party through a Referer header, and never let a shared
      // cache or a mail-client web view keep the response.
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    })
    .send(html);
}

/**
 * Shared by both verbs.
 *
 * The status codes are chosen for machines, not people. A bad token gets 200,
 * not 400: one-click clients retry 4xx and 5xx responses, and a token that
 * failed to verify will never verify, so a retry loop is pure noise for
 * everyone. A genuine internal failure gets 500 precisely *because* it makes
 * those clients retry — that request should be attempted again.
 */
export async function unsubscribeHandler(req: Request, res: Response): Promise<void> {
  try {
    const raw = (req.params as Record<string, unknown>).token;
    const token = typeof raw === "string" ? raw : "";
    const result = await applyUnsubscribe(token);
    if (result.outcome === "invalid") {
      sendHtml(res, 200, renderInvalidPage());
      return;
    }
    sendHtml(res, 200, renderUnsubscribedPage(result));
  } catch (err) {
    // Nothing may escape: an async throw here is an unhandled rejection, and
    // Express 4 will not catch it. Log for the operator, apologise to the
    // visitor, let the mail client retry.
    // eslint-disable-next-line no-console
    console.error(
      `[unsubscribe] failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      sendHtml(res, 500, renderErrorPage());
    } catch {
      // Response already committed. There is nothing left to do and throwing
      // from a catch block would defeat the entire point of this one.
    }
  }
}

/** RFC 8058 one-click. Unauthenticated, session-less, body ignored by design. */
unsubscribeRouter.post("/u/:token", (req, res) => {
  void unsubscribeHandler(req, res);
});

/** The human path. Same mutation, friendlier page. */
unsubscribeRouter.get("/u/:token", (req, res) => {
  void unsubscribeHandler(req, res);
});
