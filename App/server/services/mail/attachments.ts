import { AppDataSource } from "../../db/datasource.js";
import type { Attachment } from "../../db/entities/Attachment.js";
import { Company } from "../../db/entities/Company.js";
import type { MailAccount } from "../../db/entities/MailAccount.js";
import type { MailMessage } from "../../db/entities/MailMessage.js";
import { ATTACHMENTS_MAX_BYTES, recordAttachmentBytes } from "../uploads.js";
import { mailboxForAccount } from "./mailbox/index.js";
import type { Mailbox } from "./mailbox/types.js";

/**
 * Reading the files that arrived on an email.
 *
 * `MailMessage.attachmentsJson` is display metadata only — the mail server
 * keeps the bytes and we fetch them on demand, so nothing here is cached under
 * `data/`. Two callers need that fetch: the human download route, and the AI
 * employee, which until now could see an attachment listed on a thread and
 * had no way to open it. It could only ask the human to re-upload the file
 * into chat, which is a chore the human should never have to do for a file
 * the mailbox already holds.
 *
 * {@link importMailAttachment} closes that gap: it pulls the bytes down once
 * and records them as an ordinary chat {@link Attachment}, so every tool that
 * already speaks `attachmentId` — `read_pdf_fields`, `fill_pdf_form`,
 * `send_chat_attachment`, the mail compose tools — works on an email
 * attachment without a second file abstraction.
 */

export type MailAttachmentMeta = {
  partId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

/** What a caller sees about an attachment before opening it. `index` is the
 *  handle: a provider's own attachment ids drift, positions do not. */
export type MailAttachmentSummary = {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
};

/** Carries an HTTP status so route and tool handlers can answer honestly. */
export class MailAttachmentError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MailAttachmentError";
    this.status = status;
  }
}

export function parseMailAttachments(json: string): MailAttachmentMeta[] {
  try {
    const parsed = JSON.parse(json) as MailAttachmentMeta[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function summarizeMailAttachments(json: string): MailAttachmentSummary[] {
  return parseMailAttachments(json).map((a, index) => ({
    index,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
  }));
}

/**
 * Provider seam. Production passes nothing — the default resolves the
 * account's real mailbox. Tests supply a fake so the whole
 * resolve-and-download path can be exercised (index drift included) without a
 * network, an OAuth token, or an IMAP server.
 */
export type MailAttachmentTransport = {
  mailbox: (account: MailAccount) => Promise<Mailbox>;
};

const defaultTransport: MailAttachmentTransport = { mailbox: mailboxForAccount };

/**
 * Download one attachment's bytes.
 *
 * Attachment handles drift over time — Gmail reissues its ids, and an IMAP
 * message's part ids depend on how it was re-encoded — so the message is
 * re-fetched and its current handles recomputed. We match by the same
 * positional index the stored metadata used, which is stable across both, and
 * fall back to the stored handle.
 */
export async function fetchMailAttachmentBytes(
  account: MailAccount,
  message: MailMessage,
  index: number,
  transport: MailAttachmentTransport = defaultTransport,
): Promise<{ meta: MailAttachmentMeta; bytes: Buffer }> {
  const [only] = await fetchMailAttachmentsBytes(account, message, [index], transport);
  // The plural form throws on an unresolvable index, so one in means one out.
  return only!;
}

/**
 * Download several of a message's attachments in one pass.
 *
 * The drift re-fetch above costs one message read per call, so keeping a
 * draft's three files across an edit would otherwise fetch the same message
 * three times. Indexes are read in the order given; an empty list never
 * touches the mail server at all.
 */
export async function fetchMailAttachmentsBytes(
  account: MailAccount,
  message: MailMessage,
  indexes: number[],
  transport: MailAttachmentTransport = defaultTransport,
): Promise<Array<{ meta: MailAttachmentMeta; bytes: Buffer }>> {
  if (indexes.length === 0) return [];
  const metas = parseMailAttachments(message.attachmentsJson);
  const picked = indexes.map((index) => {
    const meta = Number.isInteger(index) ? metas[index] : undefined;
    if (!meta) {
      throw new MailAttachmentError(
        metas.length === 0
          ? "This email has no attachments."
          : `No attachment at index ${index} — this email has ${metas.length}.`,
        404,
      );
    }
    return { index, meta };
  });
  const mailbox = await transport.mailbox(account);
  const fresh = await mailbox.getMessage(message.gmailMessageId);
  const current = fresh.attachments;
  const out: Array<{ meta: MailAttachmentMeta; bytes: Buffer }> = [];
  for (const { index, meta } of picked) {
    const part =
      current[index] ??
      current.find((a) => a.partId && a.partId === meta.partId) ??
      meta;
    if (!part.attachmentId) throw new MailAttachmentError("Attachment not found", 404);
    const bytes = await mailbox.getAttachmentBytes(message.gmailMessageId, part);
    if (bytes.length === 0) throw new MailAttachmentError("Attachment is empty", 404);
    out.push({ meta, bytes });
  }
  return out;
}

/**
 * Pull an email attachment into the company's chat-attachment store and hand
 * back the row. `uploadedByUserId` stays null — the same convention every
 * AI-produced attachment follows; who imported it is recorded in the audit
 * log and journal by the caller.
 */
export async function importMailAttachment(args: {
  companyId: string;
  account: MailAccount;
  message: MailMessage;
  index: number;
  /** See {@link MailAttachmentTransport} — production omits it. */
  transport?: MailAttachmentTransport;
}): Promise<{ attachment: Attachment; meta: MailAttachmentMeta; bytes: Buffer }> {
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: args.companyId,
  });
  if (!company) throw new MailAttachmentError("Company not found", 404);

  const { meta, bytes } = await fetchMailAttachmentBytes(
    args.account,
    args.message,
    args.index,
    args.transport ?? defaultTransport,
  );
  if (bytes.length > ATTACHMENTS_MAX_BYTES) {
    const mb = Math.floor(ATTACHMENTS_MAX_BYTES / (1024 * 1024));
    throw new MailAttachmentError(
      `"${meta.filename}" is larger than the ${mb} MB attachment limit, so it can't be opened here.`,
      413,
    );
  }
  const attachment = await recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    filename: meta.filename || "attachment",
    mimeType: meta.mimeType || "application/octet-stream",
    bytes,
    uploadedByUserId: null,
  });
  return { attachment, meta, bytes };
}
