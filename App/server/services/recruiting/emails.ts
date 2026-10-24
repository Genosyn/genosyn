import crypto from "node:crypto";

import { In, MoreThan, type EntityManager } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import type { Company } from "../../db/entities/Company.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import type { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import type { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { renderEmailTemplate, type EmailTemplatePlaceholder } from "../../../shared/recruiting.js";
import { sendEmail, type SendEmailResult } from "../email.js";
import { recordApplicationEvent, type TimelineActor } from "./events.js";
import { confirmationTemplate, rejectionTemplate } from "./settings.js";
import { openingPublicUrl } from "./urls.js";

/**
 * The emails an applicant receives: "we received your application" the
 * moment they apply, and — only when a person or an AI Employee with hire
 * access chooses to send it — "we are not moving forward".
 *
 * Both are the company's own templates (Recruiting → Settings), filled with a
 * fixed set of placeholders; no model writes them. They go out through the
 * company's email provider like every other transactional email, are logged
 * at Settings → Notification email → Logs with the purpose `recruiting`, and land on the
 * Application's timeline whether they were sent, failed, or not sent.
 *
 * A public form that emails whatever address is typed into it can be turned
 * into a way to email someone else. So the confirmation is capped per address
 * per company per day — claimed atomically before it is sent, so a burst of
 * submissions cannot slip past the count together — and the only text a
 * stranger controls in it is their name, held to a rule that keeps links and
 * addresses out of it.
 */

/** Confirmations one address can receive from one company in a day. */
export const CONFIRMATIONS_PER_ADDRESS_PER_DAY = 3;

const MAX_SUBJECT_LENGTH = 200;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A bare http(s) address up to the first space, angle bracket or double quote. */
const LINK_CANDIDATE = /https?:\/\/[^\s<>"]+/g;

/**
 * The address without the punctuation that ends the sentence around it: a
 * trailing full stop, comma or quote, and a closing bracket the address did
 * not open — `(see https://w.org/Ada_(language))` keeps the inner one.
 */
function trimLink(candidate: string): string {
  let link = candidate;
  for (;;) {
    const last = link[link.length - 1];
    const unbalanced = (open: string, close: string) =>
      last === close && link.split(open).length < link.split(close).length;
    if (".,;:!?'*".includes(last) || unbalanced("(", ")") || unbalanced("[", "]")) {
      link = link.slice(0, -1);
      continue;
    }
    return link;
  }
}

/** One paragraph: links found in the raw text, every other piece escaped on its own. */
function paragraphHtml(paragraph: string): string {
  const escapeText = (text: string) => escapeHtml(text).replace(/\n/g, "<br>");
  let html = "";
  let from = 0;
  for (const match of paragraph.matchAll(LINK_CANDIDATE)) {
    const start = match.index ?? 0;
    const link = trimLink(match[0]);
    if (!/^https?:\/\/[^/?#]/.test(link)) continue;
    const href = escapeHtml(link);
    html += `${escapeText(paragraph.slice(from, start))}<a href="${href}">${href}</a>`;
    from = start + link.length;
  }
  return html + escapeText(paragraph.slice(from));
}

/** Paragraphs and line breaks from plain text, with bare http(s) links made clickable. */
export function plainTextToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map(paragraphHtml);
  return [
    '<div style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #0f172a; max-width: 560px;">',
    ...paragraphs.map((paragraph) => `<p style="margin: 0 0 16px;">${paragraph}</p>`),
    "</div>",
  ].join("\n");
}

/** A word of a stranger's name that cannot be a link, an address, or a message. */
function safeNameWord(word: string): boolean {
  return word.length > 0 && word.length <= 40 && !/[:/\\@<>.\d]/.test(word);
}

/**
 * "Hi Ada," — the one stranger-written word in the email, so it may not be a
 * link, an address, or long enough to be a message; "there" otherwise.
 */
export function safeFirstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  return safeNameWord(first) ? first : "there";
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_LENGTH);
}

/**
 * The whole name, held to the first name's rule word by word: a name with a
 * link, an address or a number anywhere in it is greeted by its first name.
 */
function safeFullName(fullName: string, firstName: string): string {
  if (firstName === "there") return "there";
  const words = oneLine(fullName).split(" ");
  return words.every(safeNameWord) ? words.join(" ").slice(0, 80) : firstName;
}

export function emailValues(
  company: Pick<Company, "name" | "slug">,
  settings: RecruitingSettings | null,
  opening: Pick<RecruitingOpening, "title" | "slug">,
  application: Pick<RecruitingApplication, "candidateName">,
): Record<EmailTemplatePlaceholder, string> {
  const companyName = oneLine(settings?.siteTitle || company.name);
  const safeName = safeFirstName(application.candidateName);
  return {
    first_name: safeName,
    full_name: safeFullName(application.candidateName, safeName),
    opening_title: oneLine(opening.title),
    company_name: companyName,
    opening_url: openingPublicUrl(company.slug, settings, opening.slug),
  };
}

type Delivery = "confirmation" | "rejection";

async function deliver(args: {
  delivery: Delivery;
  application: RecruitingApplication;
  values: Record<EmailTemplatePlaceholder, string>;
  template: { subject: string; body: string };
  actor: TimelineActor;
  triggeredByUserId?: string | null;
  /** Called with the outcome as soon as it is known, before the timeline is written. */
  onSent?: (result: SendEmailResult) => Promise<void>;
}): Promise<SendEmailResult> {
  const subject = oneLine(renderEmailTemplate(args.template.subject, args.values));
  const text = renderEmailTemplate(args.template.body, args.values);
  const result = await sendEmail({
    to: args.application.candidateEmail,
    subject,
    text,
    html: plainTextToHtml(text),
    companyId: args.application.companyId,
    purpose: "recruiting",
    triggeredByUserId: args.triggeredByUserId ?? null,
  });
  await args.onSent?.(result);
  const meta = { delivery: args.delivery, subject, emailLogId: result.logId, transport: result.transport };
  if (result.status === "sent") {
    await recordApplicationEvent({
      application: args.application,
      kind: "email_sent",
      actor: args.actor,
      body: subject,
      meta,
    });
  } else if (result.status === "failed") {
    await recordApplicationEvent({
      application: args.application,
      kind: "email_failed",
      actor: args.actor,
      body: result.errorMessage || "The email provider refused the message.",
      meta,
    });
  } else {
    await recordApplicationEvent({
      application: args.application,
      kind: "email_skipped",
      actor: args.actor,
      body: "No email provider is set up, so the email was written to the server log instead of sent. Add one at Settings → Notification email.",
      meta,
    });
  }
  return result;
}

/**
 * `confirmationEmailStatus` while the confirmation is on its way: it holds one
 * of the address's confirmations for the day until the outcome replaces it.
 */
export const CONFIRMATION_SENDING = "sending";

/** Outcomes that use up one of an address's confirmations for the day. */
const COUNTED_CONFIRMATIONS = ["sent", "failed", CONFIRMATION_SENDING];

/** Postgres advisory-lock class for confirmation claims ("RCRT"); the address picks the key. */
const CONFIRMATION_LOCK_CLASS = 0x52435254;

/** Claims waiting on one another in this process, per company and address. */
const claimChains = new Map<string, Promise<void>>();

/** Run `work` once every earlier claim for the same key in this process has finished. */
function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (claimChains.get(key) ?? Promise.resolve()).then(work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  claimChains.set(key, settled);
  void settled.then(() => {
    if (claimChains.get(key) === settled) claimChains.delete(key);
  });
  return result;
}

type ConfirmationClaim = "claimed" | "capped" | "taken";

/**
 * Decide, atomically, whether this Application's confirmation goes out: count
 * the address's confirmations from this company in the last day — those on
 * their way included — and move the Application from "not yet" to `sending`
 * (under the cap) or `skipped` (over it), but only if nothing else already
 * did. Claims for one address run one at a time in this process, and on
 * Postgres also hold an advisory lock so other replicas wait their turn; the
 * conditional update makes each Application's claim happen once either way.
 */
async function claimConfirmation(
  application: Pick<RecruitingApplication, "id" | "companyId" | "candidateEmail">,
): Promise<ConfirmationClaim> {
  const key = `${application.companyId}\u0000${application.candidateEmail}`;
  const work = async (manager: EntityManager): Promise<ConfirmationClaim> => {
    if (AppDataSource.options.type === "postgres") {
      const addressKey = crypto.createHash("sha256").update(key).digest().readInt32BE(0);
      await manager.query("SELECT pg_advisory_xact_lock($1, $2)", [CONFIRMATION_LOCK_CLASS, addressKey]);
    }
    const repo = manager.getRepository(RecruitingApplication);
    const recent = await repo.count({
      where: {
        companyId: application.companyId,
        candidateEmail: application.candidateEmail,
        confirmationEmailStatus: In(COUNTED_CONFIRMATIONS),
        createdAt: MoreThan(new Date(Date.now() - 24 * 60 * 60 * 1000)),
      },
    });
    const capped = recent >= CONFIRMATIONS_PER_ADDRESS_PER_DAY;
    const claim = await repo.update(
      { id: application.id, confirmationEmailStatus: "" },
      { confirmationEmailStatus: capped ? "skipped" : CONFIRMATION_SENDING },
    );
    if (!claim.affected) return "taken";
    return capped ? "capped" : "claimed";
  };
  return oneAtATime(key, () =>
    AppDataSource.options.type === "postgres"
      ? AppDataSource.transaction(work)
      : work(AppDataSource.manager),
  );
}

/** Send "we received your application", once, and record the outcome on the Application. */
export async function sendApplicationConfirmation(args: {
  application: RecruitingApplication;
  opening: RecruitingOpening;
  company: Pick<Company, "name" | "slug">;
  settings: RecruitingSettings | null;
}): Promise<void> {
  const repo = AppDataSource.getRepository(RecruitingApplication);
  if (args.settings && !args.settings.confirmationEmailEnabled) return;
  if (args.application.confirmationEmailStatus) return;
  const claim = await claimConfirmation(args.application);
  if (claim === "taken") return;
  if (claim === "capped") {
    await recordApplicationEvent({
      application: args.application,
      kind: "email_skipped",
      actor: { kind: "system" },
      body: `This address already received ${CONFIRMATIONS_PER_ADDRESS_PER_DAY} confirmations today, so no confirmation was sent for this application.`,
      meta: { delivery: "confirmation" },
    });
    return;
  }
  let settled = false;
  const settle = async (status: string) => {
    settled = true;
    await repo.update(
      { id: args.application.id, confirmationEmailStatus: CONFIRMATION_SENDING },
      { confirmationEmailStatus: status },
    );
  };
  try {
    await deliver({
      delivery: "confirmation",
      application: args.application,
      values: emailValues(args.company, args.settings, args.opening, args.application),
      template: confirmationTemplate(args.settings),
      actor: { kind: "system" },
      onSent: (result) => settle(result.status),
    });
  } catch (error) {
    // The send itself threw (a broken provider configuration, a lost
    // database): never leave the Application looking as if it is on its way,
    // and say why on its timeline, where "Failed" points a person.
    if (!settled) {
      await settle("failed").catch(() => undefined);
      await recordApplicationEvent({
        application: args.application,
        kind: "email_failed",
        actor: { kind: "system" },
        body: `The confirmation could not be sent: ${error instanceof Error ? error.message : String(error)}`,
        meta: { delivery: "confirmation" },
      }).catch(() => undefined);
    }
    throw error;
  }
}

/** Send the company's rejection email to one applicant. */
export async function sendRejectionEmail(args: {
  application: RecruitingApplication;
  opening: RecruitingOpening;
  company: Pick<Company, "name" | "slug">;
  settings: RecruitingSettings | null;
  actor: TimelineActor;
  triggeredByUserId?: string | null;
}): Promise<SendEmailResult> {
  return deliver({
    delivery: "rejection",
    application: args.application,
    values: emailValues(args.company, args.settings, args.opening, args.application),
    template: rejectionTemplate(args.settings),
    actor: args.actor,
    triggeredByUserId: args.triggeredByUserId,
  });
}
