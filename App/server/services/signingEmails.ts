import type { Company } from "../db/entities/Company.js";
import type { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import type { SignatureRecipient } from "../db/entities/SignatureRecipient.js";
import type { SendEmailOptions } from "./email.js";

type InvitationEnvelope = Pick<
  SignatureEnvelope,
  "companyId" | "createdByUserId" | "expiresAt" | "message" | "routingMode" | "title"
>;

type CompletionEnvelope = Pick<
  SignatureEnvelope,
  "companyId" | "completedAt" | "createdByUserId" | "title"
>;

type InvitationRecipient = Pick<SignatureRecipient, "email" | "name" | "routingOrder" | "status">;

type CompletionRecipient = Pick<SignatureRecipient, "email" | "name" | "role">;

type EmailShellParams = {
  companyName: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  content: string;
};

const MAX_EMAIL_SUBJECT_LENGTH = 180;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlWithLineBreaks(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

function subjectText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cappedSubject(value: string): string {
  const normalized = subjectText(value);
  if (normalized.length <= MAX_EMAIL_SUBJECT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_EMAIL_SUBJECT_LENGTH - 1).trimEnd()}…`;
}

function companyDisplayName(company: Pick<Company, "name">): string {
  return subjectText(company.name) || "Your sender";
}

function redactPrivateCredential(value: string, token: string, link: string): string {
  return value
    .split(link)
    .join("[private signing link redacted]")
    .split(token)
    .join("[private signing credential redacted]");
}

function formatUtcDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

function detailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:6px 12px 6px 0;color:#64748b;font-size:14px;line-height:20px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600;line-height:20px;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td>
  </tr>`;
}

function emailShell(params: EmailShellParams): string {
  const companyName = escapeHtml(params.companyName);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.heading)}</title>
  <style>
    @media only screen and (max-width: 620px) {
      .email-card { border-radius: 0 !important; }
      .email-pad { padding-left: 22px !important; padding-right: 22px !important; }
      .email-button { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div role="article" aria-roledescription="email" aria-label="${escapeHtml(params.heading)}" lang="en">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(params.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f8fafc;">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-card" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 1px 2px rgba(15,23,42,0.06);overflow:hidden;">
            <tr>
              <td class="email-pad" style="padding:24px 36px 20px;border-bottom:1px solid #e2e8f0;">
                <div style="font-size:18px;font-weight:700;line-height:24px;color:#0f172a;">${companyName}</div>
                <div style="margin-top:3px;font-size:12px;line-height:18px;color:#64748b;">Secure document signing through Genosyn</div>
              </td>
            </tr>
            <tr>
              <td class="email-pad" style="padding:34px 36px 36px;">
                <div style="margin-bottom:10px;color:#4f46e5;font-size:12px;font-weight:700;letter-spacing:0.08em;line-height:18px;text-transform:uppercase;">${escapeHtml(params.eyebrow)}</div>
                <h1 style="margin:0 0 22px;color:#0f172a;font-size:26px;line-height:34px;font-weight:700;letter-spacing:-0.02em;word-break:break-word;">${escapeHtml(params.heading)}</h1>
                ${params.content}
              </td>
            </tr>
            <tr>
              <td class="email-pad" style="padding:20px 36px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:18px;">
                Sent securely by Genosyn for ${companyName}. If you do not recognize this request, contact ${companyName} through a channel you trust.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
}

function privatePreview(params: {
  companyName: string;
  recipientName: string;
  title: string;
  action: string;
  deadline: string | null;
  token: string;
  link: string;
}): string {
  const lines = [
    `Hello ${params.recipientName},`,
    "",
    `${params.companyName} sent you a signature request.`,
    `Document: ${params.title}`,
    `Action: ${params.action}`,
    ...(params.deadline ? [`Deadline: ${params.deadline}`] : []),
    "",
    `${params.action}: [private signing link redacted]`,
  ];
  return redactPrivateCredential(lines.join("\n"), params.token, params.link);
}

export function buildSignatureInvitationEmail(params: {
  company: Pick<Company, "name">;
  envelope: InvitationEnvelope;
  recipient: InvitationRecipient;
  publicUrl: string;
  token: string;
  reminder: boolean;
}): SendEmailOptions {
  const companyName = companyDisplayName(params.company);
  const title = subjectText(params.envelope.title);
  const recipientName = subjectText(params.recipient.name) || "there";
  const link = `${params.publicUrl}/sign/${encodeURIComponent(params.token)}`;
  const deadline = params.envelope.expiresAt ? formatUtcDate(params.envelope.expiresAt) : null;
  const action = params.reminder ? "Continue signing" : "Review and sign";
  const heading = params.reminder
    ? "Your signature is still needed"
    : "Your signature is requested";
  const routingText =
    params.envelope.routingMode === "ordered"
      ? "This request follows an ordered signing flow. You are receiving it now because it is your turn."
      : "This request is being signed in parallel, so you can complete your part independently.";
  const message = params.envelope.message.trim();
  const intro = params.reminder
    ? `${companyName} is reminding you to complete the signature request below.`
    : `${companyName} has sent you the signature request below.`;
  const preheader = `${action} “${title}” for ${companyName}.`;
  const html = emailShell({
    companyName,
    preheader,
    eyebrow: params.reminder ? "Signature reminder" : "Signature request",
    heading,
    content: `<p style="margin:0 0 18px;color:#334155;font-size:16px;line-height:25px;">Hello ${escapeHtml(recipientName)},</p>
<p style="margin:0 0 22px;color:#334155;font-size:16px;line-height:25px;">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 22px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
  <tr><td style="padding:16px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    ${detailRow("Document", title)}
    ${detailRow("From", companyName)}
    ${deadline ? detailRow("Deadline", deadline) : ""}
  </table></td></tr>
</table>
${message ? `<div style="margin:0 0 22px;padding:14px 16px;border-left:3px solid #c7d2fe;background:#eef2ff;color:#334155;font-size:14px;line-height:22px;"><strong style="color:#0f172a;">Message from ${escapeHtml(companyName)}</strong><br>${escapeHtmlWithLineBreaks(message)}</div>` : ""}
<p style="margin:0 0 24px;color:#475569;font-size:14px;line-height:22px;">${escapeHtml(routingText)}</p>
<a href="${escapeHtml(link)}" class="email-button" aria-label="${escapeHtml(action)} ${escapeHtml(title)}" style="display:inline-block;padding:13px 20px;background:#4f46e5;border-radius:9px;color:#ffffff;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">${escapeHtml(action)}</a>
<p style="margin:22px 0 0;color:#64748b;font-size:12px;line-height:19px;word-break:break-all;">If the button does not work, copy and paste this private link into your browser:<br><a href="${escapeHtml(link)}" style="color:#4338ca;text-decoration:underline;">${escapeHtml(link)}</a></p>
<div style="margin-top:26px;padding-top:20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:19px;"><strong style="color:#334155;">Keep this link private.</strong> It is unique to ${escapeHtml(recipientName)} and replaces a password for this request. Genosyn will not ask you to share the link or provide a Genosyn password to sign.</div>`,
  });

  const text = [
    `Hello ${recipientName},`,
    "",
    intro,
    "",
    `Document: ${title}`,
    `From: ${companyName}`,
    ...(deadline ? [`Deadline: ${deadline}`] : []),
    "",
    ...(message ? [`Message from ${companyName}:`, message, ""] : []),
    routingText,
    "",
    `${action}:`,
    link,
    "",
    `Keep this link private. It is unique to ${recipientName} and replaces a password for this request. Genosyn will not ask you to share the link or provide a Genosyn password to sign.`,
    "",
    `Sent securely by Genosyn for ${companyName}. If you do not recognize this request, contact ${companyName} through a channel you trust.`,
  ].join("\n");

  return {
    to: params.recipient.email,
    subject: cappedSubject(
      redactPrivateCredential(
        params.reminder
          ? `[${companyName}] Reminder: ${title} needs your signature`
          : `[${companyName}] Signature requested: ${title}`,
        params.token,
        link,
      ),
    ),
    text,
    html,
    companyId: params.envelope.companyId,
    purpose: "signature",
    triggeredByUserId: params.envelope.createdByUserId,
    bodyPreview: privatePreview({
      companyName,
      recipientName,
      title,
      action,
      deadline,
      token: params.token,
      link,
    }),
  };
}

export function buildSignatureCompletionEmail(params: {
  company: Pick<Company, "name">;
  envelope: CompletionEnvelope;
  recipients: CompletionRecipient[];
  filename: string;
}): SendEmailOptions {
  const recipient = params.recipients[0];
  const companyName = companyDisplayName(params.company);
  const title = subjectText(params.envelope.title);
  const recipientName = subjectText(recipient?.name ?? "") || "there";
  const signed = params.recipients.some((entry) => entry.role === "signer");
  const completedAt = params.envelope.completedAt
    ? formatUtcDate(params.envelope.completedAt)
    : "Recently";
  const roleContext = signed
    ? "Thank you for completing your part."
    : `You are receiving the final copy because ${companyName} included you as a copy recipient.`;
  const preheader = `The completed PDF for “${title}” is attached.`;
  const html = emailShell({
    companyName,
    preheader,
    eyebrow: "Signature request complete",
    heading: "The signed document is ready",
    content: `<p style="margin:0 0 18px;color:#334155;font-size:16px;line-height:25px;">Hello ${escapeHtml(recipientName)},</p>
<p style="margin:0 0 22px;color:#334155;font-size:16px;line-height:25px;">The signature request from ${escapeHtml(companyName)} is complete. ${escapeHtml(roleContext)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 22px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
  <tr><td style="padding:16px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    ${detailRow("Document", title)}
    ${detailRow("From", companyName)}
    ${detailRow("Status", "Complete")}
    ${detailRow("Completed", completedAt)}
  </table></td></tr>
</table>
<div style="margin:0 0 24px;padding:16px 18px;border:1px solid #c7d2fe;border-radius:12px;background:#eef2ff;color:#312e81;font-size:14px;line-height:22px;"><strong>Attached signed PDF</strong><br>${escapeHtml(params.filename)}</div>
<p style="margin:0;color:#475569;font-size:14px;line-height:22px;">Keep the attached document for your records. Its completion certificate records the signing timestamps, consent, and document-integrity evidence.</p>
<div style="margin-top:26px;padding-top:20px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:19px;"><strong style="color:#334155;">Security note:</strong> The signed PDF may contain personal or confidential information. Store and share it with the same care as the original agreement.</div>`,
  });
  const text = [
    `Hello ${recipientName},`,
    "",
    `The signature request from ${companyName} is complete. ${roleContext}`,
    "",
    `Document: ${title}`,
    `From: ${companyName}`,
    "Status: Complete",
    `Completed: ${completedAt}`,
    `Attached signed PDF: ${params.filename}`,
    "",
    "Keep the attached document for your records. Its completion certificate records the signing timestamps, consent, and document-integrity evidence.",
    "",
    "Security note: The signed PDF may contain personal or confidential information. Store and share it with the same care as the original agreement.",
    "",
    `Sent securely by Genosyn for ${companyName}.`,
  ].join("\n");

  return {
    to: recipient?.email ?? "",
    subject: cappedSubject(`[${companyName}] Completed: ${title}`),
    text,
    html,
    companyId: params.envelope.companyId,
    purpose: "signature",
    triggeredByUserId: params.envelope.createdByUserId,
    bodyPreview: text,
  };
}
