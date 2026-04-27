import nodemailer, { Transporter } from "nodemailer";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import {
  EmailLog,
  EmailLogPurpose,
  EmailLogTransport,
} from "../db/entities/EmailLog.js";
import {
  EmailProvider,
  EmailProviderKind,
} from "../db/entities/EmailProvider.js";
import { decryptSecret } from "../lib/secret.js";
import {
  EmailMessage,
  EmailProviderConfig,
  sendViaProvider,
  validateProviderConfig,
} from "./emailTransports.js";

/**
 * Public email API used everywhere outside the email-providers settings
 * pages. Resolves a transport in this order:
 *
 *   1. The default `EmailProvider` row for `companyId`, if one exists and
 *      is enabled.
 *   2. The legacy global SMTP block in `config.ts` (still useful for
 *      system-level sends — signup welcome, password reset).
 *   3. Console fallback so dev/self-host without SMTP still surfaces the
 *      message somewhere.
 *
 * Every attempt — successful, failed, or skipped — appends an `EmailLog`
 * row so admins can audit deliverability from the Settings → Email Logs
 * page.
 */

const BODY_PREVIEW_CAP = 16 * 1024;

let configSmtpTransporter: Transporter | null = null;

function getConfigSmtpTransporter(): Transporter | null {
  if (!config.smtp.host) return null;
  if (!configSmtpTransporter) {
    configSmtpTransporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
  }
  return configSmtpTransporter;
}

export type SendEmailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Pick a company-default provider when set. Otherwise falls back to
   *  config.ts SMTP, then console. */
  companyId?: string | null;
  /** Reason the email was sent — surfaces as a filter on the logs page. */
  purpose?: EmailLogPurpose;
  /** User who triggered the send (when known); recorded on the log row. */
  triggeredByUserId?: string | null;
};

export type SendEmailResult = {
  status: "sent" | "skipped" | "failed";
  transport: EmailLogTransport;
  messageId: string;
  errorMessage: string;
  logId: string;
};

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const purpose: EmailLogPurpose = opts.purpose ?? "other";
  const triggeredByUserId = opts.triggeredByUserId ?? null;

  const provider = opts.companyId
    ? await loadDefaultProvider(opts.companyId)
    : null;

  if (provider) {
    const cfg = decryptProviderConfig(provider);
    const msg: EmailMessage = {
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      fromAddress: provider.fromAddress,
      replyTo: provider.replyTo || undefined,
    };
    try {
      const result = await sendViaProvider(cfg, msg);
      const log = await writeLog({
        companyId: opts.companyId ?? null,
        providerId: provider.id,
        transport: provider.kind,
        purpose,
        toAddress: opts.to,
        fromAddress: provider.fromAddress,
        subject: opts.subject,
        bodyPreview: opts.text,
        status: "sent",
        errorMessage: "",
        messageId: result.messageId,
        triggeredByUserId,
      });
      return {
        status: "sent",
        transport: provider.kind,
        messageId: result.messageId,
        errorMessage: "",
        logId: log.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const log = await writeLog({
        companyId: opts.companyId ?? null,
        providerId: provider.id,
        transport: provider.kind,
        purpose,
        toAddress: opts.to,
        fromAddress: provider.fromAddress,
        subject: opts.subject,
        bodyPreview: opts.text,
        status: "failed",
        errorMessage: message,
        messageId: "",
        triggeredByUserId,
      });
      return {
        status: "failed",
        transport: provider.kind,
        messageId: "",
        errorMessage: message,
        logId: log.id,
      };
    }
  }

  const fallbackTransporter = getConfigSmtpTransporter();
  if (fallbackTransporter) {
    try {
      const info = await fallbackTransporter.sendMail({
        from: config.smtp.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
      const messageId = info.messageId ?? "";
      const log = await writeLog({
        companyId: opts.companyId ?? null,
        providerId: null,
        transport: "config_smtp",
        purpose,
        toAddress: opts.to,
        fromAddress: config.smtp.from,
        subject: opts.subject,
        bodyPreview: opts.text,
        status: "sent",
        errorMessage: "",
        messageId,
        triggeredByUserId,
      });
      return {
        status: "sent",
        transport: "config_smtp",
        messageId,
        errorMessage: "",
        logId: log.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const log = await writeLog({
        companyId: opts.companyId ?? null,
        providerId: null,
        transport: "config_smtp",
        purpose,
        toAddress: opts.to,
        fromAddress: config.smtp.from,
        subject: opts.subject,
        bodyPreview: opts.text,
        status: "failed",
        errorMessage: message,
        messageId: "",
        triggeredByUserId,
      });
      return {
        status: "failed",
        transport: "config_smtp",
        messageId: "",
        errorMessage: message,
        logId: log.id,
      };
    }
  }

  // No transport configured — log to console so a developer can copy
  // reset / invite links by hand, and persist a "skipped" log row.
  // eslint-disable-next-line no-console
  console.log(
    `[email:skipped] to=${opts.to} subject="${opts.subject}"\n---\n${opts.text}\n---`,
  );
  const log = await writeLog({
    companyId: opts.companyId ?? null,
    providerId: null,
    transport: "console",
    purpose,
    toAddress: opts.to,
    fromAddress: config.smtp.from,
    subject: opts.subject,
    bodyPreview: opts.text,
    status: "skipped",
    errorMessage: "No email provider configured",
    messageId: "",
    triggeredByUserId,
  });
  return {
    status: "skipped",
    transport: "console",
    messageId: "",
    errorMessage: "No email provider configured",
    logId: log.id,
  };
}

/**
 * Send a one-off message using an inline (un-persisted) provider config —
 * the "Test send" button on the providers form needs to validate
 * credentials before saving them. The result is logged with
 * `purpose: "test"` so admins can see test attempts in the logs page.
 */
export async function sendTestEmail(args: {
  companyId: string;
  kind: EmailProviderKind;
  fromAddress: string;
  replyTo?: string;
  rawConfig: Record<string, unknown>;
  to: string;
  triggeredByUserId?: string | null;
}): Promise<SendEmailResult> {
  const validated = validateProviderConfig(args.kind, args.rawConfig);
  const subject = "Genosyn — test email";
  const text =
    "This is a test message from Genosyn confirming that your email provider " +
    "settings are valid. If you received this, deliverability is working.";
  const html =
    "<p>This is a test message from <strong>Genosyn</strong> confirming that your " +
    "email provider settings are valid.</p>" +
    "<p>If you received this, deliverability is working.</p>";
  try {
    const result = await sendViaProvider(validated, {
      to: args.to,
      subject,
      text,
      html,
      fromAddress: args.fromAddress,
      replyTo: args.replyTo,
    });
    const log = await writeLog({
      companyId: args.companyId,
      providerId: null,
      transport: args.kind,
      purpose: "test",
      toAddress: args.to,
      fromAddress: args.fromAddress,
      subject,
      bodyPreview: text,
      status: "sent",
      errorMessage: "",
      messageId: result.messageId,
      triggeredByUserId: args.triggeredByUserId ?? null,
    });
    return {
      status: "sent",
      transport: args.kind,
      messageId: result.messageId,
      errorMessage: "",
      logId: log.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const log = await writeLog({
      companyId: args.companyId,
      providerId: null,
      transport: args.kind,
      purpose: "test",
      toAddress: args.to,
      fromAddress: args.fromAddress,
      subject,
      bodyPreview: text,
      status: "failed",
      errorMessage: message,
      messageId: "",
      triggeredByUserId: args.triggeredByUserId ?? null,
    });
    return {
      status: "failed",
      transport: args.kind,
      messageId: "",
      errorMessage: message,
      logId: log.id,
    };
  }
}

async function loadDefaultProvider(
  companyId: string,
): Promise<EmailProvider | null> {
  const repo = AppDataSource.getRepository(EmailProvider);
  const row = await repo.findOne({
    where: { companyId, isDefault: true, enabled: true },
  });
  return row ?? null;
}

export function decryptProviderConfig(
  provider: EmailProvider,
): EmailProviderConfig {
  const raw = decryptSecret(provider.encryptedConfig);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Email provider config is corrupted or was encrypted with a different sessionSecret.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Email provider config has an unexpected shape.");
  }
  return validateProviderConfig(
    provider.kind,
    parsed as Record<string, unknown>,
  );
}

async function writeLog(args: {
  companyId: string | null;
  providerId: string | null;
  transport: EmailLogTransport;
  purpose: EmailLogPurpose;
  toAddress: string;
  fromAddress: string;
  subject: string;
  bodyPreview: string;
  status: "sent" | "failed" | "skipped";
  errorMessage: string;
  messageId: string;
  triggeredByUserId: string | null;
}): Promise<EmailLog> {
  try {
    const repo = AppDataSource.getRepository(EmailLog);
    const row = repo.create({
      companyId: args.companyId,
      providerId: args.providerId,
      transport: args.transport,
      purpose: args.purpose,
      toAddress: args.toAddress,
      fromAddress: args.fromAddress,
      subject: args.subject,
      bodyPreview: args.bodyPreview.slice(0, BODY_PREVIEW_CAP),
      status: args.status,
      errorMessage: args.errorMessage,
      messageId: args.messageId,
      triggeredByUserId: args.triggeredByUserId,
    });
    return await repo.save(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[email] failed to write delivery log", err);
    // Synthesize a stand-in row so callers can still return a logId-like
    // identifier without throwing.
    return {
      id: "",
      companyId: args.companyId,
      providerId: args.providerId,
      transport: args.transport,
      purpose: args.purpose,
      toAddress: args.toAddress,
      fromAddress: args.fromAddress,
      subject: args.subject,
      bodyPreview: args.bodyPreview,
      status: args.status,
      errorMessage: args.errorMessage,
      messageId: args.messageId,
      triggeredByUserId: args.triggeredByUserId,
      createdAt: new Date(),
    } as EmailLog;
  }
}
