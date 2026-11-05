import crypto from "node:crypto";

import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import type { SupportJob } from "../../db/entities/SupportJob.js";
import { SupportTicket } from "../../db/entities/SupportTicket.js";
import {
  SUPPORT_LIMITS,
  SUPPORT_RATING_LINK_DAYS,
  ticketReference,
} from "../../../shared/support.js";
import { createNotifications } from "../notifications.js";
import { getPublicUrl } from "../publicUrl.js";
import { patchTicket, recordTicketEvent } from "./access.js";
import { SupportNotFoundError, SupportValidationError } from "./errors.js";
import type { SupportJobOutcome } from "./queue.js";
import { sendAutomatedMessage } from "./replies.js";

/**
 * Asking a customer how it went. Their link is the only credential on the page it
 * opens, and only its hash is kept, so a copy of the database opens nothing. The
 * page shows the ticket's subject and takes a rating; it reads no conversation.
 * A rating only ever arrives by a person pressing a button on that page, never by
 * loading the link, because mail scanners follow links.
 */

const TOKEN_BYTES = 32;

export function hashRatingToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Mint a customer's rating link, replacing any earlier one. */
export async function mintRatingLink(ticket: SupportTicket): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  await patchTicket(ticket, {
    ratingTokenHash: hashRatingToken(token),
    ratingRequestedAt: new Date(),
    ratingDueAt: null,
  });
  return `${getPublicUrl()}/feedback/${encodeURIComponent(token)}`;
}

export async function runRatingJob(
  job: Pick<SupportJob, "companyId" | "targetId">,
): Promise<SupportJobOutcome> {
  const ticket = await AppDataSource.getRepository(SupportTicket).findOneBy({
    id: job.targetId,
    companyId: job.companyId,
  });
  // Reopened in the meantime, or already asked: the question no longer fits.
  if (
    !ticket ||
    ticket.status !== "solved" ||
    ticket.ratingRequestedAt ||
    ticket.ratingScore !== null
  ) {
    return { outcome: "done" };
  }
  // The link is minted first, and that stamp means this email goes out at most once.
  const link = await mintRatingLink(ticket);
  const lead = `How did we do on "${ticket.subject}"?`;
  try {
    const sent = await sendAutomatedMessage({
      ticket,
      body: `${lead}\n\nLet us know in one click: ${link}`,
      storedBody: `${lead}\n\n(The customer's rating link goes here.)`,
    });
    if (sent)
      await recordTicketEvent({ ticket, kind: "rating_requested", actor: { kind: "system" } });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[support] could not ask for a rating on ticket ${ticket.id}:`, error);
  }
  return { outcome: "done" };
}

export type RatingContext = { ticket: SupportTicket; companyName: string; expired: boolean };

export async function lookupRating(token: string): Promise<RatingContext | null> {
  const ticket = await AppDataSource.getRepository(SupportTicket).findOneBy({
    ratingTokenHash: hashRatingToken(token),
  });
  if (!ticket) return null;
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: ticket.companyId });
  const requested = ticket.ratingRequestedAt?.getTime() ?? 0;
  return {
    ticket,
    companyName: company?.name ?? "",
    expired: Date.now() - requested > SUPPORT_RATING_LINK_DAYS * 24 * 60 * 60_000,
  };
}

export function ratingPage(context: RatingContext) {
  return {
    companyName: context.companyName,
    subject: context.ticket.subject,
    reference: ticketReference(context.ticket.number),
    score: context.ticket.ratingScore,
    comment: context.ticket.ratingComment,
    ratedAt: context.ticket.ratingAt?.toISOString() ?? null,
    expired: context.expired,
  };
}

/** Take a rating; the same link may change it while it lasts. */
export async function submitRating(args: {
  token: string;
  score: number;
  comment?: string;
}): Promise<RatingContext> {
  const context = await lookupRating(args.token);
  if (!context) throw new SupportNotFoundError("This link is invalid.");
  if (context.expired) throw new SupportValidationError("This link has expired.");
  const { ticket } = context;
  // Anyone with the link can post this, and Postgres refuses a NUL byte in text.
  const comment = (args.comment ?? "")
    .replaceAll("\u0000", "")
    .trim()
    .slice(0, SUPPORT_LIMITS.ratingCommentChars);
  const first = ticket.ratingScore === null;
  await patchTicket(ticket, {
    ratingScore: args.score,
    ratingComment: comment,
    ratingAt: new Date(),
  });
  await recordTicketEvent({
    ticket,
    kind: "rated",
    actor: { kind: "customer", name: ticket.requesterName || ticket.requesterEmail },
    data: { score: args.score },
  });
  if (first && args.score <= 2 && ticket.assigneeUserId) {
    await createNotifications([
      {
        companyId: ticket.companyId,
        userId: ticket.assigneeUserId,
        kind: "support_low_rating",
        title: `${ticket.requesterName || ticket.requesterEmail} rated ${ticketReference(ticket.number)} ${args.score} of 5`,
        body: comment || ticket.subject,
        link: `/support/tickets/${ticket.id}`,
        actorKind: "system",
        entityKind: "support_ticket",
        entityId: ticket.id,
      },
    ]);
  }
  const refreshed = await lookupRating(args.token);
  return refreshed ?? context;
}
