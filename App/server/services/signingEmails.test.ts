import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSignatureCompletionEmail, buildSignatureInvitationEmail } from "./signingEmails.js";

const deadline = new Date("2026-08-21T15:30:00.000Z");
const completedAt = new Date("2026-08-22T09:12:00.000Z");

test("invitation email has an exact useful plain-text fallback and a responsive accessible HTML version", () => {
  const email = buildSignatureInvitationEmail({
    company: { name: "Acme & Sons" },
    envelope: {
      companyId: "company-1",
      createdByUserId: "user-1",
      expiresAt: deadline,
      message: "Please review <today>.\nCall us with questions.",
      routingMode: "ordered",
      title: "Mutual <Agreement>\n2026",
    },
    recipient: {
      email: "ada@example.com",
      name: "Ada <Signer>",
      routingOrder: 1,
      status: "sent",
    },
    publicUrl: "https://sign.example.test",
    token: "private-token",
    reminder: false,
  });

  assert.equal(email.subject, "[Acme & Sons] Signature requested: Mutual <Agreement> 2026");
  assert.equal(
    email.text,
    `Hello Ada <Signer>,

Acme & Sons has sent you the signature request below.

Document: Mutual <Agreement> 2026
From: Acme & Sons
Deadline: Friday, August 21, 2026 at 3:30 PM UTC

Message from Acme & Sons:
Please review <today>.
Call us with questions.

This request follows an ordered signing flow. You are receiving it now because it is your turn.

Review and sign:
https://sign.example.test/sign/private-token

Keep this link private. It is unique to Ada <Signer> and replaces a password for this request. Genosyn will not ask you to share the link or provide a Genosyn password to sign.

Sent securely by Genosyn for Acme & Sons. If you do not recognize this request, contact Acme & Sons through a channel you trust.`,
  );
  assert.equal(
    email.bodyPreview,
    `Hello Ada <Signer>,

Acme & Sons sent you a signature request.
Document: Mutual <Agreement> 2026
Action: Review and sign
Deadline: Friday, August 21, 2026 at 3:30 PM UTC

Review and sign: [private signing link redacted]`,
  );
  assert.equal(email.to, "ada@example.com");
  assert.equal(email.companyId, "company-1");
  assert.equal(email.purpose, "signature");
  assert.equal(email.triggeredByUserId, "user-1");
  const activeLink = "https://sign.example.test/sign/private-token";
  assert.equal(email.text.split(activeLink).length - 1, 1);
  assert.doesNotMatch(email.subject, /private-token|https:\/\//);
  assert.doesNotMatch(email.bodyPreview ?? "", /private-token|https:\/\//);

  assert.ok(email.html);
  assert.match(email.html, /^<!doctype html>/);
  assert.match(email.html, /<html lang="en">/);
  assert.match(email.html, /<meta name="viewport"/);
  assert.match(email.html, /role="article"/);
  assert.match(email.html, /role="presentation"/);
  assert.match(email.html, /@media only screen and \(max-width: 620px\)/);
  assert.match(email.html, /aria-label="Review and sign Mutual &lt;Agreement&gt; 2026"/);
  assert.match(email.html, />Acme &amp; Sons</);
  assert.match(email.html, /Mutual &lt;Agreement&gt; 2026/);
  assert.match(email.html, /Please review &lt;today&gt;\.<br>Call us with questions\./);
  assert.doesNotMatch(email.html, /<Agreement>|<today>/);
  assert.match(email.html, /href="https:\/\/sign\.example\.test\/sign\/private-token"/);
});

test("reminder email uses a recipient-specific continuation action and explains parallel routing", () => {
  const email = buildSignatureInvitationEmail({
    company: { name: "Northstar" },
    envelope: {
      companyId: "company-1",
      createdByUserId: null,
      expiresAt: deadline,
      message: "",
      routingMode: "parallel",
      title: "Services agreement",
    },
    recipient: {
      email: "jules@example.com",
      name: "Jules",
      routingOrder: 0,
      status: "viewed",
    },
    publicUrl: "https://genosyn.example",
    token: "replacement-token",
    reminder: true,
  });

  assert.equal(email.subject, "[Northstar] Reminder: Services agreement needs your signature");
  assert.match(email.text, /Northstar is reminding you to complete the signature request below\./);
  assert.match(email.text, /This request is being signed in parallel/);
  assert.match(
    email.text,
    /Continue signing:\nhttps:\/\/genosyn\.example\/sign\/replacement-token/,
  );
  assert.match(email.text, /Deadline: Friday, August 21, 2026 at 3:30 PM UTC/);
  assert.ok(email.html);
  assert.match(email.html, />Signature reminder</);
  assert.match(email.html, />Continue signing<\/a>/);
  assert.match(email.html, />Deadline<\/td>/);
  assert.match(email.bodyPreview ?? "", /Action: Continue signing/);
});

test("invitation audit fields redact the exact bearer credential even if user copy repeats it", () => {
  const token = "credential-that-must-never-persist";
  const link = `https://sign.example.test/sign/${token}`;
  const email = buildSignatureInvitationEmail({
    company: { name: `Company ${token}\r\nBcc: victim@example.com` },
    envelope: {
      companyId: "company-1",
      createdByUserId: null,
      expiresAt: null,
      message: `Do not persist ${link}`,
      routingMode: "parallel",
      title: `Agreement ${token} ${"x".repeat(220)}\r\nX-Injected: yes`,
    },
    recipient: {
      email: "signer@example.com",
      name: `Signer ${token}`,
      routingOrder: 0,
      status: "sent",
    },
    publicUrl: "https://sign.example.test",
    token,
    reminder: false,
  });

  assert.match(email.text, new RegExp(`/sign/${token}`));
  assert.match(email.html ?? "", new RegExp(`/sign/${token}`));
  assert.doesNotMatch(email.subject, new RegExp(token));
  assert.doesNotMatch(email.subject, /[\r\n]/);
  assert.equal(email.subject.length <= 180, true);
  assert.doesNotMatch(email.subject, /https:\/\//);
  assert.doesNotMatch(email.bodyPreview ?? "", new RegExp(token));
  assert.doesNotMatch(email.bodyPreview ?? "", /https:\/\//);
  assert.doesNotMatch(email.bodyPreview ?? "", /\/sign\/credential/);
  assert.match(email.subject, /private signing credential redacted/);
  assert.match(email.bodyPreview ?? "", /private signing (?:link|credential) redacted/);
});

test("completion email gives signers a clear receipt and identifies the attached signed PDF", () => {
  const email = buildSignatureCompletionEmail({
    company: { name: "Acme Test" },
    envelope: {
      companyId: "company-1",
      completedAt,
      createdByUserId: "user-1",
      title: "Mutual agreement",
    },
    recipients: [{ email: "casey@example.com", name: "Casey", role: "signer" }],
    filename: "mutual-agreement-signed.pdf",
  });

  assert.equal(email.subject, "[Acme Test] Completed: Mutual agreement");
  assert.equal(
    email.text,
    `Hello Casey,

The signature request from Acme Test is complete. Thank you for completing your part.

Document: Mutual agreement
From: Acme Test
Status: Complete
Completed: Saturday, August 22, 2026 at 9:12 AM UTC
Attached signed PDF: mutual-agreement-signed.pdf

Keep the attached document for your records. Its completion certificate records the signing timestamps, consent, and document-integrity evidence.

Security note: The signed PDF may contain personal or confidential information. Store and share it with the same care as the original agreement.

Sent securely by Genosyn for Acme Test.`,
  );
  assert.equal(email.bodyPreview, email.text);
  assert.equal(email.to, "casey@example.com");
  assert.ok(email.html);
  assert.match(email.html, /The signed document is ready/);
  assert.match(email.html, /Attached signed PDF/);
  assert.match(email.html, /mutual-agreement-signed\.pdf/);
  assert.match(email.html, /completion certificate records the signing timestamps/);
  assert.doesNotMatch(email.html, /href=/);
});

test("completion email explains why a copy recipient receives the final document", () => {
  const email = buildSignatureCompletionEmail({
    company: { name: "Acme & Test" },
    envelope: {
      companyId: "company-1",
      completedAt,
      createdByUserId: null,
      title: "Mutual <agreement>",
    },
    recipients: [{ email: "legal@example.com", name: "Legal <Team>", role: "copy" }],
    filename: "mutual-<agreement>&-signed.pdf",
  });

  assert.match(
    email.text,
    /You are receiving the final copy because Acme & Test included you as a copy recipient\./,
  );
  assert.doesNotMatch(email.text, /Thank you for completing your part/);
  assert.match(email.html ?? "", /included you as a copy recipient/);
  assert.match(email.html ?? "", /Mutual &lt;agreement&gt;/);
  assert.match(email.html ?? "", /Legal &lt;Team&gt;/);
  assert.match(email.html ?? "", /mutual-&lt;agreement&gt;&amp;-signed\.pdf/);
  assert.doesNotMatch(email.html ?? "", /<agreement>|<Team>/);
});
