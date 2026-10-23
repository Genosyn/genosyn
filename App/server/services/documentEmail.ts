import { AppDataSource } from "../db/datasource.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
import { formatGlobalSmtpSender, getEffectiveGlobalSmtp } from "./globalEmailTransport.js";

/**
 * What emailing a customer document — an invoice or an estimate — has in
 * common: who it will appear to come from, and how the To and Cc lines a
 * Member confirmed are turned into the addresses it goes to.
 *
 * Both documents are sent from the send dialog on their page, which shows the
 * sender and takes the recipients, so the two must agree on both. They used
 * to live inside `finance.ts`, where only invoices could reach them.
 */

/** Everything the send dialog shows about an email before it goes out. */
export type DocumentEmailDetails = {
  /** The customer's billing email: the To line the dialog starts with. */
  toAddress: string;
  /** Finance → Settings → Always Cc, comma-separated. Empty for estimates. */
  alwaysCcAddress: string;
  fromAddress: string;
  replyTo: string;
  /** False when nothing would deliver it: the attempt is logged, not sent. */
  configured: boolean;
  source: "company_provider" | "global_smtp" | "console";
};

export type EmailSenderPreview = Omit<DocumentEmailDetails, "toAddress" | "alwaysCcAddress">;

/**
 * The sender a company's next transactional email will use, resolved the way
 * `sendEmail` resolves it: the default company provider, else the global SMTP
 * transport, else the console.
 */
export async function resolveEmailSenderPreview(companyId: string): Promise<EmailSenderPreview> {
  const provider = await AppDataSource.getRepository(EmailProvider).findOne({
    where: { companyId, isDefault: true, enabled: true },
  });
  if (provider) {
    return {
      fromAddress: provider.fromAddress,
      replyTo: provider.replyTo,
      configured: true,
      source: "company_provider",
    };
  }

  const global = await getEffectiveGlobalSmtp();
  return {
    fromAddress: formatGlobalSmtpSender(global.settings),
    replyTo: "",
    configured: global.configured && Boolean(global.settings.host),
    source: global.configured ? "global_smtp" : "console",
  };
}

/** Trim, drop blanks, and keep the first spelling of each address, compared case-insensitively. */
export function normalizeRecipientAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.flatMap((address) => {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
}

/**
 * The To line of a document email: the list the Member confirmed, or the
 * customer's billing email when they confirmed none. Throws the reason it
 * cannot be addressed, in words that say what to do.
 */
export function resolveToRecipients(billingEmail: string, to: string[] | undefined): string[] {
  if (!billingEmail && to === undefined) {
    throw new Error("Customer has no email address — add one before sending");
  }
  const resolved = normalizeRecipientAddresses(to ?? (billingEmail ? [billingEmail] : []));
  if (resolved.length === 0) throw new Error("Add at least one To recipient");
  return resolved;
}

/**
 * The Cc line: every list given, de-duplicated, without anyone already on the
 * To line — a person copied on their own email would receive it twice.
 */
export function resolveCcRecipients(to: string[], ...lists: string[][]): string[] {
  const onTo = new Set(to.map((address) => address.trim().toLowerCase()));
  return normalizeRecipientAddresses(lists.flat()).filter(
    (address) => !onTo.has(address.toLowerCase()),
  );
}
