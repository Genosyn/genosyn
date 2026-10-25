import type { Company } from "../../db/entities/Company.js";
import type { DataRoom } from "../../db/entities/DataRoom.js";
import type { DataRoomGuest } from "../../db/entities/DataRoomGuest.js";
import type { SendEmailOptions } from "../email.js";

/**
 * The two emails a data room sends a guest: the invitation with their private
 * link, and word that a question they asked was answered.
 *
 * The link is a bearer credential, so the copy kept in Email logs
 * (`bodyPreview`) never carries it — the same rule as a signing invitation.
 */

type Room = Pick<DataRoom, "name">;
type Guest = Pick<DataRoomGuest, "name" | "email">;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lines(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

function oneLine(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function subject(value: string): string {
  const text = oneLine(value);
  return text.length <= 180 ? text : `${text.slice(0, 179).trimEnd()}…`;
}

function companyName(company: Pick<Company, "name">): string {
  return oneLine(company.name) || "A company";
}

function shell(params: {
  companyName: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  content: string;
}): string {
  const name = escapeHtml(params.companyName);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(params.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f8fafc;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="padding:24px 36px 20px;border-bottom:1px solid #e2e8f0;">
              <div style="font-size:18px;font-weight:700;line-height:24px;color:#0f172a;">${name}</div>
              <div style="margin-top:3px;font-size:12px;line-height:18px;color:#64748b;">A private data room, shared through Genosyn</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 36px 36px;">
              <div style="margin-bottom:10px;color:#4f46e5;font-size:13px;font-weight:600;line-height:18px;">${escapeHtml(params.eyebrow)}</div>
              <h1 style="margin:0 0 20px;color:#0f172a;font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.02em;">${escapeHtml(params.heading)}</h1>
              ${params.content}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:18px;">
              This link is personal to you. Please do not forward it. If you did not expect this email, contact ${name} through a channel you trust.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function button(link: string, label: string): string {
  return `<a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;border-radius:10px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(label)}</a>`;
}

export function buildGuestInvitationEmail(params: {
  company: Pick<Company, "name">;
  room: Room;
  guest: Guest;
  link: string;
  message: string;
  expiresAt: Date | null;
}): SendEmailOptions {
  const from = companyName(params.company);
  const roomName = oneLine(params.room.name);
  const greeting = oneLine(params.guest.name) || "there";
  const note = params.message.trim();
  const expiry = params.expiresAt
    ? `Your access ends on ${params.expiresAt.toISOString().slice(0, 10)}.`
    : "";
  const text = [
    `Hello ${greeting},`,
    "",
    `${from} has invited you to their data room "${roomName}".`,
    ...(note ? ["", note] : []),
    "",
    `Open the room: ${params.link}`,
    ...(expiry ? ["", expiry] : []),
    "",
    "This link is personal to you. Please do not forward it.",
  ].join("\n");
  const html = shell({
    companyName: from,
    preheader: `${from} shared the data room "${roomName}" with you.`,
    eyebrow: "Data room invitation",
    heading: `You're invited to ${roomName}`,
    content: `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:25px;">Hello ${escapeHtml(greeting)},</p>
<p style="margin:0 0 20px;color:#334155;font-size:16px;line-height:25px;">${escapeHtml(from)} has invited you to their data room <strong>${escapeHtml(roomName)}</strong>. You can read its documents and ask questions there.</p>
${note ? `<div style="margin:0 0 22px;padding:14px 16px;border-left:3px solid #c7d2fe;background:#eef2ff;color:#334155;font-size:14px;line-height:22px;"><strong style="color:#0f172a;">Message from ${escapeHtml(from)}</strong><br>${lines(note)}</div>` : ""}
<p style="margin:0 0 22px;">${button(params.link, "Open the data room")}</p>
${expiry ? `<p style="margin:0;color:#64748b;font-size:13px;line-height:20px;">${escapeHtml(expiry)}</p>` : ""}`,
  });
  return {
    to: params.guest.email,
    subject: subject(`${from} shared "${roomName}" with you`),
    text,
    html,
    purpose: "data_room",
    bodyPreview: text.split(params.link).join("[private data room link redacted]"),
  };
}

export function buildAnswerEmail(params: {
  company: Pick<Company, "name">;
  room: Room;
  guest: Guest;
  link: string;
  question: string;
}): SendEmailOptions {
  const from = companyName(params.company);
  const roomName = oneLine(params.room.name);
  const greeting = oneLine(params.guest.name) || "there";
  const asked = oneLine(params.question).slice(0, 240);
  const text = [
    `Hello ${greeting},`,
    "",
    `${from} answered your question in "${roomName}":`,
    `"${asked}"`,
    "",
    `Read the answer: ${params.link}`,
  ].join("\n");
  const html = shell({
    companyName: from,
    preheader: `${from} answered your question in "${roomName}".`,
    eyebrow: "Your question was answered",
    heading: `New answer in ${roomName}`,
    content: `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:25px;">Hello ${escapeHtml(greeting)},</p>
<p style="margin:0 0 14px;color:#334155;font-size:16px;line-height:25px;">${escapeHtml(from)} answered your question:</p>
<div style="margin:0 0 22px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;color:#334155;font-size:14px;line-height:22px;">${escapeHtml(asked)}</div>
<p style="margin:0;">${button(params.link, "Read the answer")}</p>`,
  });
  return {
    to: params.guest.email,
    subject: subject(`Your question in "${roomName}" was answered`),
    text,
    html,
    purpose: "data_room",
    bodyPreview: text.split(params.link).join("[private data room link redacted]"),
  };
}
