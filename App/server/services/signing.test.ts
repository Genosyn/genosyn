import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { createCanvas } from "@napi-rs/canvas";
import { degrees, PDFDocument } from "pdf-lib";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { SignatureEvent } from "../db/entities/SignatureEvent.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { SignatureField } from "../db/entities/SignatureField.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { SignatureRecipient } from "../db/entities/SignatureRecipient.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { pdfBufferToText } from "./resources.js";
import {
  SigningConflictError,
  SigningValidationError,
  completeSignatureRecipient,
  composeSigningContext,
  createSignatureEnvelopeFromUpload,
  declineSignatureRecipient,
  deleteSigningGrant,
  expireSignatureEnvelopes,
  generateSignatureRecipientToken,
  getSignatureEnvelopeDetail,
  hashSignatureRecipientToken,
  hasSigningAccess,
  isValidSignatureRecipientToken,
  injectSigningFinalizationFailureForTests,
  lookupSignatureRecipientByToken,
  normalizedFieldBoxForPage,
  remindSignatureRecipient,
  resolvePublicSignatureDocument,
  resolveSigningStoragePath,
  retrySignatureEnvelopeFinalization,
  sendSignatureEnvelope,
  sha256Buffer,
  signatureFieldValueManifestSha256,
  updateSignatureEnvelopeDraft,
  upsertSigningGrant,
  validateSignatureFieldCoordinates,
  verifySignatureEventChain,
  voidSignatureEnvelope,
} from "./signing.js";

const originalDataDir = config.dataDir;
let testDataDir = "";

before(async () => {
  testDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "genosyn-signing-test-"));
  (config as { dataDir: string }).dataDir = testDataDir;
  await initTestDb();
});

beforeEach(resetTestDb);

after(async () => {
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  await fs.promises.rm(testDataDir, { recursive: true, force: true });
});

async function fixtureCompany(suffix = testId("slug").replace(/_/g, "-")): Promise<Company> {
  return insert(Company, {
    name: "Acme Test",
    slug: suffix,
    ownerId: testId("user"),
  });
}

async function makePdfFile(name = "agreement.pdf", pageCount = 1): Promise<Express.Multer.File> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Agreement page ${index + 1}`, { x: 48, y: 730, size: 18 });
  }
  const bytes = Buffer.from(await pdf.save());
  const filePath = path.join(testDataDir, `${testId("upload")}.pdf`);
  await fs.promises.writeFile(filePath, bytes);
  return {
    fieldname: "file",
    originalname: name,
    encoding: "7bit",
    mimetype: "application/pdf",
    size: bytes.length,
    destination: testDataDir,
    filename: path.basename(filePath),
    path: filePath,
    buffer: bytes,
    stream: fs.createReadStream(filePath),
  };
}

async function makeRotatedCroppedPdfFile(): Promise<Express.Multer.File> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([800, 1000]);
  page.setCropBox(50, 100, 400, 600);
  page.setRotation(degrees(90));
  page.drawText("Rotated customer agreement", { x: 90, y: 640, size: 18 });
  const bytes = Buffer.from(await pdf.save());
  const filePath = path.join(testDataDir, `${testId("geometry")}.pdf`);
  await fs.promises.writeFile(filePath, bytes);
  return {
    fieldname: "file",
    originalname: "rotated-cropped-agreement.pdf",
    encoding: "7bit",
    mimetype: "application/pdf",
    size: bytes.length,
    destination: testDataDir,
    filename: path.basename(filePath),
    path: filePath,
    buffer: bytes,
    stream: fs.createReadStream(filePath),
  };
}

function signer(key: string, email: string, routingOrder = 0) {
  return {
    key,
    role: "signer" as const,
    name: key === "one" ? "Alice Signer" : "Bob Signer",
    email,
    routingOrder,
  };
}

function signatureField(recipientKey: string, pageNumber = 1, x = 0.1) {
  return {
    recipientKey,
    type: "signature" as const,
    label: "Signature",
    required: true,
    pageNumber,
    x,
    y: 0.72,
    width: 0.28,
    height: 0.08,
  };
}

async function createDraft(params: {
  company: Company;
  routingMode?: "parallel" | "ordered";
  recipients?: ReturnType<typeof signer>[];
  copyRecipients?: Array<{
    key: string;
    role: "copy";
    name: string;
    email: string;
    routingOrder: number;
  }>;
  pageCount?: number;
  includeDate?: boolean;
  expiresAt?: Date;
}) {
  const recipients = params.recipients ?? [signer("one", "alice@example.com")];
  return createSignatureEnvelopeFromUpload({
    company: params.company,
    file: await makePdfFile("agreement.pdf", params.pageCount ?? 1),
    title: "Mutual agreement",
    message: "Please review carefully.",
    routingMode: params.routingMode ?? "parallel",
    expiresAt: params.expiresAt,
    recipients: [...recipients, ...(params.copyRecipients ?? [])],
    fields: recipients.flatMap((recipient, index) => [
      signatureField(recipient.key, 1, 0.1 + index * 0.35),
      ...(params.includeDate
        ? [
            {
              recipientKey: recipient.key,
              type: "date" as const,
              label: "Date signed",
              required: true,
              pageNumber: 1,
              x: 0.1 + index * 0.35,
              y: 0.62,
              width: 0.28,
              height: 0.06,
            },
          ]
        : []),
    ]),
    actor: { actorKind: "user", actorId: params.company.ownerId },
  });
}

async function quietly<T>(operation: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = original;
  }
}

async function installKnownToken(recipientId: string): Promise<string> {
  const token = generateSignatureRecipientToken();
  await AppDataSource.getRepository(SignatureRecipient).update(
    { id: recipientId },
    { tokenHash: hashSignatureRecipientToken(token) },
  );
  return token;
}

async function assertEnvelopeWasNeverSent(companyId: string, envelopeId: string): Promise<void> {
  const detail = await getSignatureEnvelopeDetail({ companyId, envelopeId });
  assert.equal(detail.envelope.status, "draft");
  assert.equal(detail.envelope.sentAt, null);
  assert.ok(detail.recipients.every((recipient) => recipient.status === "waiting"));
  assert.ok(detail.recipients.every((recipient) => recipient.tokenHash === null));
  assert.equal(
    detail.events.some((event) => event.type === "envelope_sent"),
    false,
  );
  assert.equal(
    detail.events.some((event) => event.type === "recipient_sent"),
    false,
  );
}

test("recipient tokens are 32 random base64url bytes and only deterministic hashes persist", () => {
  const first = generateSignatureRecipientToken();
  const second = generateSignatureRecipientToken();
  assert.equal(isValidSignatureRecipientToken(first), true);
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.notEqual(first, second);
  assert.match(hashSignatureRecipientToken(first), /^[a-f0-9]{64}$/);
  assert.equal(hashSignatureRecipientToken(first), hashSignatureRecipientToken(first));
  assert.notEqual(hashSignatureRecipientToken(first), first);
  assert.equal(isValidSignatureRecipientToken("not-a-token"), false);
});

test("delivery logs never persist recipient bearer links", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const tokenHash = sent.recipients[0].tokenHash;
  assert.ok(tokenHash);
  const log = await AppDataSource.getRepository(EmailLog).findOneByOrFail({
    companyId: company.id,
    purpose: "signature",
  });
  assert.match(log.bodyPreview, /private signing link redacted/);
  assert.doesNotMatch(log.bodyPreview, /\/sign\/[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(log.bodyPreview, new RegExp(tokenHash));
});

test("normalized field validation rejects missing pages and page overflow", () => {
  assert.doesNotThrow(() =>
    validateSignatureFieldCoordinates({ pageNumber: 1, x: 0, y: 0, width: 1, height: 1 }, 1),
  );
  assert.throws(
    () =>
      validateSignatureFieldCoordinates({ pageNumber: 2, x: 0, y: 0, width: 0.1, height: 0.1 }, 1),
    SigningValidationError,
  );
  assert.throws(
    () =>
      validateSignatureFieldCoordinates(
        { pageNumber: 1, x: 0.95, y: 0, width: 0.1, height: 0.1 },
        1,
      ),
    /fit inside/,
  );
});

test("normalized fields map through CropBox and page rotation exactly like the PDF preview", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([800, 1000]);
  page.setCropBox(50, 100, 400, 600);
  const field = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
  const expected = [
    { rotation: 0 as const, x: 90, y: 520, width: 120, height: 60 },
    { rotation: 90 as const, x: 170, y: 160, width: 180, height: 40 },
    { rotation: 180 as const, x: 410, y: 280, width: 120, height: 60 },
    { rotation: 270 as const, x: 330, y: 640, width: 180, height: 40 },
  ];

  for (const geometry of expected) {
    page.setRotation(degrees(geometry.rotation));
    assert.deepEqual(normalizedFieldBoxForPage(page, field), geometry);
  }
});

test("draft creation validates real PDFs, recipient ownership, and required signatures", async () => {
  const company = await fixtureCompany();
  const invalid = await makePdfFile("fake.pdf");
  await fs.promises.writeFile(invalid.path, "not a pdf");
  await assert.rejects(
    createSignatureEnvelopeFromUpload({
      company,
      file: invalid,
      title: "Invalid",
      actor: { userId: company.ownerId },
    }),
    SigningValidationError,
  );
  assert.equal(fs.existsSync(invalid.path), false, "invalid temp upload is removed");

  await assert.rejects(
    createSignatureEnvelopeFromUpload({
      company,
      file: await makePdfFile("too-many-pages.pdf", 201),
      title: "Too many pages",
      actor: { userId: company.ownerId },
    }),
    /200 pages or fewer/,
  );

  await assert.rejects(
    createSignatureEnvelopeFromUpload({
      company,
      file: await makePdfFile(),
      title: "No signature field",
      recipients: [signer("one", "alice@example.com")],
      fields: [
        {
          ...signatureField("one"),
          type: "text",
        },
      ],
      actor: { userId: company.ownerId },
    }),
    /needs at least one required signature field/,
  );

  const detail = await createDraft({ company, pageCount: 2 });
  assert.equal(detail.envelope.status, "draft");
  assert.equal(detail.envelope.originalPageCount, 2);
  assert.match(detail.envelope.originalSha256, /^[a-f0-9]{64}$/);
  assert.equal(detail.recipients.length, 1);
  assert.equal(detail.fields[0].value, null);
});

test("draft saves reject stale revisions and always advance the optimistic revision", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const firstRevision = draft.envelope.updatedAt.toISOString();
  const saved = await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    expectedUpdatedAt: firstRevision,
    title: "First editor's revision",
    actor: { userId: company.ownerId },
  });
  assert.ok(saved.envelope.updatedAt.getTime() > draft.envelope.updatedAt.getTime());
  await assert.rejects(
    updateSignatureEnvelopeDraft({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      expectedUpdatedAt: firstRevision,
      title: "Stale editor's revision",
      actor: { userId: company.ownerId },
    }),
    /changed since you opened it/,
  );
  const unchanged = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: draft.envelope.id,
  });
  assert.equal(unchanged.envelope.title, "First editor's revision");
});

test("send refuses a draft revision that changed after review", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const reviewedRevision = draft.envelope.updatedAt.toISOString();
  const updated = await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    expectedUpdatedAt: reviewedRevision,
    message: "Changed in another tab",
    actor: { userId: company.ownerId },
  });

  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      expectedUpdatedAt: reviewedRevision,
      actor: { userId: company.ownerId },
    }),
    /changed since you reviewed it/,
  );
  assert.equal(
    (
      await getSignatureEnvelopeDetail({
        companyId: company.id,
        envelopeId: draft.envelope.id,
      })
    ).envelope.status,
    "draft",
  );

  const sent = await sendSignatureEnvelope({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    expectedUpdatedAt: updated.envelope.updatedAt.toISOString(),
    actor: { userId: company.ownerId },
  });
  assert.equal(sent.envelope.status, "sent");
});

test("incremental drafts save incomplete work while send enforces full readiness", async () => {
  const company = await fixtureCompany();
  const draft = await createSignatureEnvelopeFromUpload({
    company,
    file: await makePdfFile(),
    title: "Untitled agreement",
    actor: { userId: company.ownerId },
  });

  const metadataOnly = await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    title: "Agreement being prepared",
    message: "Still gathering signer details.",
    recipients: [],
    fields: [],
    actor: { userId: company.ownerId },
  });
  assert.equal(metadataOnly.envelope.title, "Agreement being prepared");
  assert.equal(metadataOnly.envelope.message, "Still gathering signer details.");
  assert.deepEqual(metadataOnly.recipients, []);
  assert.deepEqual(metadataOnly.fields, []);

  const expiredAt = new Date(Date.now() - 60_000);
  const partial = await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    expiresAt: expiredAt,
    recipients: [
      {
        key: "signer",
        role: "signer",
        name: "",
        email: "ada@",
        routingOrder: 0,
      },
    ],
    fields: [],
    actor: { userId: company.ownerId },
  });
  assert.equal(partial.recipients[0].name, "");
  assert.equal(partial.recipients[0].email, "ada@");
  assert.equal(partial.fields.length, 0);
  assert.equal(partial.envelope.expiresAt?.toISOString(), expiredAt.toISOString());

  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /Recipient 1 needs a name before sending/,
  );

  const invalidEmail = await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    recipients: [
      {
        key: "signer",
        role: "signer",
        name: "Ada Lovelace",
        email: "ada@",
        routingOrder: 0,
      },
    ],
    fields: [{ ...signatureField("signer"), type: "text" }],
    actor: { userId: company.ownerId },
  });
  assert.equal(invalidEmail.fields[0].recipientId, invalidEmail.recipients[0].id);
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /Ada Lovelace needs a valid email address before sending/,
  );

  await assert.rejects(
    updateSignatureEnvelopeDraft({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      recipients: [
        {
          key: "signer",
          role: "signer",
          name: "Ada Lovelace",
          email: "ada@",
          routingOrder: 0,
        },
      ],
      fields: [{ ...signatureField("missing"), type: "text" }],
      actor: { userId: company.ownerId },
    }),
    /Field 1 recipient was not found/,
  );
  const afterDanglingField = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: draft.envelope.id,
  });
  assert.equal(afterDanglingField.fields[0].recipientId, afterDanglingField.recipients[0].id);

  await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    recipients: [signer("one", "ada@example.com", 0), signer("two", "ADA@example.com", 1)],
    fields: [],
    actor: { userId: company.ownerId },
  });
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /Recipient email addresses must be unique before sending/,
  );

  await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    recipients: [
      {
        key: "signer",
        role: "signer",
        name: "Ada Lovelace",
        email: "ada@example.com",
        routingOrder: 0,
      },
    ],
    fields: [],
    actor: { userId: company.ownerId },
  });
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /Ada Lovelace needs at least one required signature field/,
  );

  await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    recipients: [
      {
        key: "signer",
        role: "signer",
        name: "Ada Lovelace",
        email: "ada@example.com",
        routingOrder: 0,
      },
    ],
    fields: [signatureField("signer")],
    actor: { userId: company.ownerId },
  });
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /Choose a future expiration before sending/,
  );

  await updateSignatureEnvelopeDraft({
    companyId: company.id,
    envelopeId: draft.envelope.id,
    expiresAt: new Date(Date.now() + 86_400_000),
    actor: { userId: company.ownerId },
  });
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const sent = await sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    });
    assert.equal(sent.envelope.status, "sent");
    assert.equal(sent.recipients[0].status, "sent");
  } finally {
    console.log = originalLog;
  }
});

test("send preflight rejects missing, changed, and unrenderable immutable inputs atomically", async () => {
  const company = await fixtureCompany();

  const missing = await createDraft({ company });
  const missingPath = resolveSigningStoragePath(company.slug, missing.envelope.originalStorageKey);
  assert.ok(missingPath);
  await fs.promises.unlink(missingPath);
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: missing.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /original PDF is missing/,
  );
  await assertEnvelopeWasNeverSent(company.id, missing.envelope.id);

  const changed = await createDraft({ company });
  const changedPath = resolveSigningStoragePath(company.slug, changed.envelope.originalStorageKey);
  assert.ok(changedPath);
  await fs.promises.writeFile(changedPath, "%PDF-1.7\nchanged after upload");
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: changed.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /original PDF failed its integrity check/,
  );
  await assertEnvelopeWasNeverSent(company.id, changed.envelope.id);

  const immutableName = "A very long immutable recipient name ".repeat(8).slice(0, 255);
  const unrenderable = await createSignatureEnvelopeFromUpload({
    company,
    file: await makePdfFile(),
    title: "Immutable auto-field preflight",
    recipients: [
      {
        key: "immutable",
        role: "signer",
        name: immutableName,
        email: "immutable@example.com",
      },
    ],
    fields: [
      signatureField("immutable"),
      {
        recipientKey: "immutable",
        type: "name",
        label: "Legal name",
        required: true,
        pageNumber: 1,
        x: 0.1,
        y: 0.62,
        width: 0.04,
        height: 0.025,
      },
    ],
    actor: { userId: company.ownerId },
  });
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: unrenderable.envelope.id,
      actor: { userId: company.ownerId },
    }),
    /Legal name does not fit in its PDF field/,
  );
  await assertEnvelopeWasNeverSent(company.id, unrenderable.envelope.id);
});

test("ordered routing releases one signer group, invalidates reminders, and keeps sent data immutable", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({
    company,
    routingMode: "ordered",
    recipients: [signer("one", "alice@example.com", 0), signer("two", "bob@example.com", 1)],
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  assert.equal(sent.envelope.status, "sent");
  assert.equal(sent.recipients[0].status, "sent");
  assert.match(sent.recipients[0].tokenHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(sent.recipients[1].status, "waiting");
  assert.equal(sent.recipients[1].tokenHash, null);

  await assert.rejects(
    updateSignatureEnvelopeDraft({
      companyId: company.id,
      envelopeId: sent.envelope.id,
      title: "Changed after send",
      actor: { userId: company.ownerId },
    }),
    SigningConflictError,
  );

  const oldToken = await installKnownToken(sent.recipients[0].id);
  await quietly(() =>
    remindSignatureRecipient({
      companyId: company.id,
      envelopeId: sent.envelope.id,
      recipientId: sent.recipients[0].id,
      actor: { userId: company.ownerId },
    }),
  );
  assert.equal(await lookupSignatureRecipientByToken({ token: oldToken }), null);

  const signingToken = await installKnownToken(sent.recipients[0].id);
  const firstField = sent.fields.find((field) => field.recipientId === sent.recipients[0].id);
  assert.ok(firstField);
  await quietly(() =>
    completeSignatureRecipient({
      token: signingToken,
      consent: true,
      values: [{ fieldId: firstField.id, type: "signature", value: "Alice Signer" }],
      ipAddress: "203.0.113.8",
      userAgent: "Signing test",
    }),
  );
  const after = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: sent.envelope.id,
  });
  assert.equal(after.envelope.status, "in_progress");
  assert.equal(after.recipients[0].status, "completed");
  assert.equal(after.recipients[1].status, "sent");
  assert.match(after.recipients[1].tokenHash ?? "", /^[a-f0-9]{64}$/);
  await assert.rejects(
    retrySignatureEnvelopeFinalization({ token: signingToken }),
    /not ready to be completed/,
  );
  assert.equal(
    (
      await verifySignatureEventChain({
        companyId: after.envelope.companyId,
        envelopeId: after.envelope.id,
      })
    ).valid,
    true,
  );
});

test("rapid audit events are strictly chained and tampering is detected", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  for (let index = 0; index < 5; index += 1) {
    await updateSignatureEnvelopeDraft({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      title: `Agreement revision ${index}`,
      actor: { userId: company.ownerId },
    });
  }
  const events = await AppDataSource.getRepository(SignatureEvent).find({
    where: { companyId: company.id, envelopeId: draft.envelope.id },
    order: { createdAt: "ASC", id: "ASC" },
  });
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].createdAt.getTime() > events[index - 1].createdAt.getTime());
    assert.equal(events[index].previousHash, events[index - 1].eventHash);
  }
  assert.equal(
    (
      await verifySignatureEventChain({
        companyId: draft.envelope.companyId,
        envelopeId: draft.envelope.id,
      })
    ).valid,
    true,
  );
  await AppDataSource.getRepository(SignatureEvent).update(
    { id: events[2].id },
    { metadataJson: '{"tampered":true}' },
  );
  const verification = await verifySignatureEventChain({
    companyId: draft.envelope.companyId,
    envelopeId: draft.envelope.id,
  });
  assert.equal(verification.valid, false);
  assert.match(verification.error, /hash is invalid/);
});

test("completion stamps a PDF, appends an evidence page, archives a contract, and leaves a safe receipt link", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({
    company,
    includeDate: true,
    copyRecipients: [
      {
        key: "copy",
        role: "copy",
        name: "Casey Copy",
        email: "casey@example.com",
        routingOrder: 0,
      },
    ],
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  const result = await quietly(() =>
    completeSignatureRecipient({
      token,
      consent: true,
      values: { [sent.fields[0].id]: "Alice Signer" },
      timezoneOffsetMinutes: 720,
      timeZone: "Etc/GMT+12",
      ipAddress: "198.51.100.23",
      userAgent: "Mozilla/5.0 signing-test",
    }),
  );
  assert.equal(result.completed, true);

  const completed = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: sent.envelope.id,
  });
  assert.equal(completed.envelope.status, "completed");
  assert.match(completed.envelope.completedSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(completed.envelope.completedSha256, completed.envelope.originalSha256);
  assert.ok(completed.envelope.customerContractId);
  const contract = await AppDataSource.getRepository(CustomerContract).findOneBy({
    id: completed.envelope.customerContractId!,
    companyId: company.id,
  });
  assert.ok(contract);
  assert.equal(contract.sizeBytes, completed.envelope.completedSizeBytes);

  const receipt = await lookupSignatureRecipientByToken({ token });
  assert.ok(receipt);
  assert.equal(receipt.recipient.status, "completed");
  assert.equal("tokenHash" in receipt.recipient, false);
  assert.equal("documentText" in receipt.envelope, false);
  assert.equal("valueJson" in receipt.fields[0], false);

  // The signing deadline gates unsigned actions, not the recipient's durable
  // read-only receipt after everybody has completed.
  await AppDataSource.getRepository(SignatureEnvelope).update(
    { id: completed.envelope.id, companyId: company.id },
    { expiresAt: new Date(Date.now() - 60_000) },
  );
  assert.ok(await lookupSignatureRecipientByToken({ token }));

  const resolved = await resolvePublicSignatureDocument({ token, variant: "completed" });
  const bytes = await fs.promises.readFile(resolved.path);
  assert.equal(sha256Buffer(bytes), resolved.sha256);
  if (process.env.SIGNING_QA_OUTPUT) {
    await fs.promises.writeFile(process.env.SIGNING_QA_OUTPUT, bytes);
  }
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2, "certificate is appended after the signed source page");
  const extractedText = await pdfBufferToText(bytes);
  assert.match(extractedText, /Accepted field values SHA-256: [a-f0-9]{64}/);
  assert.match(extractedText, /Signer timezone: Etc\/GMT\+12 \(UTC offset minutes: 720\)/);
  const completionEvent = completed.events.find((event) => event.type === "recipient_completed");
  assert.equal(completionEvent?.metadata.timezoneOffsetMinutes, 720);
  assert.equal(completionEvent?.metadata.timeZone, "Etc/GMT+12");
  const dateField = completed.fields.find((field) => field.type === "date");
  assert.ok(dateField);
  assert.equal(dateField.value, completionEvent?.metadata.signingCalendarDate);
  assert.equal(
    completionEvent?.metadata.valueManifestSha256,
    signatureFieldValueManifestSha256(
      completed.fields.filter((field) => field.recipientId === completed.recipients[0].id),
    ),
  );
  assert.equal(
    (
      await verifySignatureEventChain({
        companyId: completed.envelope.companyId,
        envelopeId: completed.envelope.id,
      })
    ).valid,
    true,
  );
  assert.ok(completed.recipients.every((recipient) => recipient.lastDeliveryStatus === "skipped"));
  assert.ok(completed.recipients.every((recipient) => recipient.lastDeliveredAt));

  const repeated = await quietly(() =>
    completeSignatureRecipient({
      token,
      consent: true,
      values: { [sent.fields[0].id]: "Second attempt" },
    }),
  );
  assert.equal(repeated.completed, true, "a completed receipt is an idempotent success");
});

test("a completed signer can retry finalization after a filesystem failure without duplicating evidence", async () => {
  const company = await fixtureCompany();
  const expiresAt = new Date(Date.now() + 1_000);
  const draft = await createDraft({ company, expiresAt });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  try {
    injectSigningFinalizationFailureForTests(new Error("Injected finalization failure"));
    await assert.rejects(
      completeSignatureRecipient({
        token,
        consent: true,
        values: { [sent.fields[0].id]: "Alice Signer" },
        ipAddress: "198.51.100.52",
        userAgent: "Finalization recovery regression",
      }),
      /Injected finalization failure/,
    );

    const stranded = await getSignatureEnvelopeDetail({
      companyId: company.id,
      envelopeId: sent.envelope.id,
    });
    assert.equal(stranded.envelope.status, "in_progress");
    assert.equal(stranded.recipients[0].status, "completed");
    assert.deepEqual(stranded.fields[0].value, { kind: "typed", text: "Alice Signer" });
    assert.equal(stranded.events.filter((event) => event.type === "recipient_consented").length, 1);
    assert.equal(stranded.events.filter((event) => event.type === "recipient_completed").length, 1);

    // A deadline passing after the human signature was durably accepted must
    // not turn a transient finalization failure into permanent data loss. The
    // persisted definition stays unchanged; only wall-clock time advances.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 10)),
    );
    assert.equal(await expireSignatureEnvelopes({ companyId: company.id }), 0);
    assert.ok(await lookupSignatureRecipientByToken({ token }));

    injectSigningFinalizationFailureForTests(null);
    const recovered = await quietly(() => retrySignatureEnvelopeFinalization({ token }));
    assert.equal(recovered.completed, true);
  } finally {
    injectSigningFinalizationFailureForTests(null);
  }

  const completed = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: sent.envelope.id,
  });
  assert.equal(completed.envelope.status, "completed");
  assert.deepEqual(completed.fields[0].value, { kind: "typed", text: "Alice Signer" });
  assert.equal(completed.events.filter((event) => event.type === "recipient_consented").length, 1);
  assert.equal(completed.events.filter((event) => event.type === "recipient_completed").length, 1);
  assert.equal(completed.events.filter((event) => event.type === "envelope_completed").length, 1);
  assert.equal(
    await AppDataSource.getRepository(CustomerContract).countBy({
      companyId: company.id,
    }),
    1,
  );
});

test("finalization renders recipient evidence from the verified event chain", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  const originalIp = "198.51.100.77";
  const originalUserAgent = "Original evidence agent";
  try {
    injectSigningFinalizationFailureForTests(new Error("Injected evidence-integrity gap"));
    await assert.rejects(
      completeSignatureRecipient({
        token,
        consent: true,
        values: { [sent.fields[0].id]: "Alice Signer" },
        ipAddress: originalIp,
        userAgent: originalUserAgent,
      }),
      /Injected evidence-integrity gap/,
    );

    const stranded = await getSignatureEnvelopeDetail({
      companyId: company.id,
      envelopeId: sent.envelope.id,
    });
    const consentEvent = stranded.events.find((event) => event.type === "recipient_consented");
    const completionEvent = stranded.events.find((event) => event.type === "recipient_completed");
    assert.ok(consentEvent);
    assert.ok(completionEvent);

    const alteredConsent = new Date("2001-01-01T00:00:00.000Z");
    const alteredCompletion = new Date("2002-02-02T00:00:00.000Z");
    await AppDataSource.getRepository(SignatureRecipient).update(
      { id: sent.recipients[0].id, companyId: company.id },
      {
        consentedAt: alteredConsent,
        completedAt: alteredCompletion,
        ipAddress: "203.0.113.250",
        userAgent: "Altered recipient evidence",
      },
    );

    injectSigningFinalizationFailureForTests(null);
    const recovered = await quietly(() => retrySignatureEnvelopeFinalization({ token }));
    assert.equal(recovered.completed, true);

    const document = await resolvePublicSignatureDocument({ token, variant: "completed" });
    const extracted = await pdfBufferToText(await fs.promises.readFile(document.path));
    assert.ok(extracted.includes(`Consent: ${consentEvent.createdAt.toISOString()}`));
    assert.ok(extracted.includes(`Signed: ${completionEvent.createdAt.toISOString()}`));
    assert.ok(extracted.includes(`IP: ${originalIp}`));
    assert.ok(extracted.includes(`User agent: ${originalUserAgent}`));
    assert.equal(extracted.includes(alteredConsent.toISOString()), false);
    assert.equal(extracted.includes(alteredCompletion.toISOString()), false);
    assert.equal(extracted.includes("203.0.113.250"), false);
    assert.equal(extracted.includes("Altered recipient evidence"), false);
  } finally {
    injectSigningFinalizationFailureForTests(null);
  }
});

test("finalization refuses field values changed after the signed manifest was committed", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  try {
    injectSigningFinalizationFailureForTests(new Error("Injected manifest-check gap"));
    await assert.rejects(
      completeSignatureRecipient({
        token,
        consent: true,
        values: { [sent.fields[0].id]: "Alice Signer" },
      }),
      /Injected manifest-check gap/,
    );
    await AppDataSource.getRepository(SignatureField).update(
      { id: sent.fields[0].id },
      { valueJson: JSON.stringify({ kind: "typed", text: "Altered after consent" }) },
    );
    injectSigningFinalizationFailureForTests(null);
    await assert.rejects(
      quietly(() =>
        completeSignatureRecipient({
          token,
          consent: true,
          values: { [sent.fields[0].id]: "Ignored retry value" },
        }),
      ),
      /accepted field values failed their integrity check/,
    );
  } finally {
    injectSigningFinalizationFailureForTests(null);
  }
});

test("finalization refuses an expiration deadline changed after send", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  try {
    injectSigningFinalizationFailureForTests(new Error("Injected deadline-integrity gap"));
    await assert.rejects(
      completeSignatureRecipient({
        token,
        consent: true,
        values: { [sent.fields[0].id]: "Alice Signer" },
      }),
      /Injected deadline-integrity gap/,
    );
    await AppDataSource.getRepository(SignatureEnvelope).update(
      { id: sent.envelope.id, companyId: company.id },
      { expiresAt: new Date(Date.now() + 86_400_000) },
    );
    injectSigningFinalizationFailureForTests(null);
    await assert.rejects(
      quietly(() => retrySignatureEnvelopeFinalization({ token })),
      /frozen signature request definition failed its integrity check/,
    );
  } finally {
    injectSigningFinalizationFailureForTests(null);
  }
});

test("completion preserves supported international text and rejects non-fitting values atomically", async () => {
  const company = await fixtureCompany();
  const internationalName = "José Ελληνικά Кириллица محمد 张伟";
  const draft = await createSignatureEnvelopeFromUpload({
    company,
    file: await makePdfFile(),
    title: "国际 соглашение اتفاقية",
    recipients: [
      { key: "international", role: "signer", name: internationalName, email: "jose@example.com" },
    ],
    fields: [
      { ...signatureField("international"), width: 0.8 },
      {
        recipientKey: "international",
        type: "text",
        label: "Exact text",
        required: true,
        pageNumber: 1,
        x: 0.1,
        y: 0.6,
        width: 0.8,
        height: 0.08,
      },
    ],
    actor: { userId: company.ownerId },
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const signature = sent.fields.find((field) => field.type === "signature");
  const exactText = sent.fields.find((field) => field.type === "text");
  assert.ok(signature);
  assert.ok(exactText);
  const token = await installKnownToken(sent.recipients[0].id);
  const preserved = "  Café Ελληνικά Привет محمد 张伟  ";
  await quietly(() =>
    completeSignatureRecipient({
      token,
      consent: true,
      values: {
        [signature.id]: internationalName,
        [exactText.id]: preserved,
      },
      userAgent: "International QA 🧪",
    }),
  );
  const completed = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: sent.envelope.id,
  });
  assert.equal(completed.fields.find((field) => field.id === exactText.id)?.value, preserved);
  const document = await resolvePublicSignatureDocument({ token, variant: "completed" });
  const completedBytes = await fs.promises.readFile(document.path);
  if (process.env.SIGNING_UNICODE_QA_OUTPUT) {
    await fs.promises.writeFile(process.env.SIGNING_UNICODE_QA_OUTPUT, completedBytes);
  }
  const extracted = await pdfBufferToText(completedBytes);
  for (const fragment of ["Café", "Ελληνικά", "Привет", "محمد", "张伟"]) {
    assert.ok(extracted.includes(fragment), `completed PDF preserves ${fragment}`);
  }
  assert.match(extracted, /International QA \\u\{1F9EA\}/);

  const tooLongDraft = await createDraft({ company });
  const tooLongSent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: tooLongDraft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const tooLongToken = await installKnownToken(tooLongSent.recipients[0].id);
  await assert.rejects(
    quietly(() =>
      completeSignatureRecipient({
        token: tooLongToken,
        consent: true,
        values: { [tooLongSent.fields[0].id]: "W".repeat(255) },
      }),
    ),
    /does not fit in its PDF field/,
  );
  const unchanged = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: tooLongSent.envelope.id,
  });
  assert.equal(unchanged.recipients[0].status, "sent");
  assert.equal(unchanged.recipients[0].consentedAt, null);
  assert.equal(unchanged.fields[0].value, null);
  assert.equal(
    unchanged.events.some((event) => event.type === "recipient_completed"),
    false,
  );
});

test("completion paginates certificate evidence without dropping any signer", async () => {
  const company = await fixtureCompany();
  const signerCount = 12;
  const recipients = Array.from({ length: signerCount }, (_, index) => ({
    key: `signer-${index + 1}`,
    role: "signer" as const,
    name: `Evidence Signer ${index + 1}`,
    email: `evidence-signer-${index + 1}@example.com`,
    routingOrder: index,
  }));
  const draft = await createSignatureEnvelopeFromUpload({
    company,
    file: await makePdfFile(),
    title: "Multi-signer evidence agreement",
    recipients,
    fields: recipients.map((recipient) => signatureField(recipient.key)),
    actor: { userId: company.ownerId },
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );

  let receiptToken = "";
  for (let index = 0; index < sent.recipients.length; index += 1) {
    const recipient = sent.recipients[index];
    const field = sent.fields.find((candidate) => candidate.recipientId === recipient.id);
    assert.ok(field);
    receiptToken = await installKnownToken(recipient.id);
    const result = await quietly(() =>
      completeSignatureRecipient({
        token: receiptToken,
        consent: true,
        values: { [field.id]: recipient.name },
        ipAddress: `198.51.100.${index + 1}`,
        userAgent: "Genosyn multi-page certificate regression test",
      }),
    );
    assert.equal(result.completed, index === signerCount - 1);
  }

  const completed = await resolvePublicSignatureDocument({
    token: receiptToken,
    variant: "completed",
  });
  const bytes = await fs.promises.readFile(completed.path);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 3, "signer evidence spans at least two certificate pages");
  const extractedText = await pdfBufferToText(bytes);
  for (const recipient of recipients) {
    assert.ok(
      extractedText.includes(recipient.name),
      `certificate includes evidence for ${recipient.name}`,
    );
  }
});

test("completion stamps rotated, cropped source pages without changing their display geometry", async () => {
  const company = await fixtureCompany();
  const draft = await createSignatureEnvelopeFromUpload({
    company,
    file: await makeRotatedCroppedPdfFile(),
    title: "Rotated agreement",
    recipients: [signer("one", "alice@example.com")],
    fields: [signatureField("one", 1, 0.1)],
    actor: { userId: company.ownerId },
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  await quietly(() =>
    completeSignatureRecipient({
      token,
      consent: true,
      values: { [sent.fields[0].id]: "Alice Signer" },
    }),
  );
  const completed = await resolvePublicSignatureDocument({ token, variant: "completed" });
  const completedBytes = await fs.promises.readFile(completed.path);
  if (process.env.SIGNING_ROTATED_QA_OUTPUT) {
    await fs.promises.writeFile(process.env.SIGNING_ROTATED_QA_OUTPUT, completedBytes);
  }
  const output = await PDFDocument.load(completedBytes);
  const signedPage = output.getPage(0);
  assert.equal(signedPage.getRotation().angle, 90);
  assert.deepEqual(signedPage.getCropBox(), { x: 50, y: 100, width: 400, height: 600 });
  const stampBox = normalizedFieldBoxForPage(signedPage, sent.fields[0]);
  assert.equal(stampBox.rotation, 90);
  assert.ok(Math.abs(stampBox.x - 370) < 1e-9);
  assert.ok(Math.abs(stampBox.y - 160) < 1e-9);
  assert.ok(Math.abs(stampBox.width - 168) < 1e-9);
  assert.ok(Math.abs(stampBox.height - 32) < 1e-9);
  assert.equal(output.getPageCount(), 2);
});

test("parallel routing releases every signer while copy recipients receive no bearer token", async () => {
  const company = await fixtureCompany();
  const draft = await createSignatureEnvelopeFromUpload({
    company,
    file: await makePdfFile(),
    title: "Parallel agreement",
    routingMode: "parallel",
    recipients: [
      signer("one", "alice@example.com", 0),
      signer("two", "bob@example.com", 8),
      {
        key: "copy",
        role: "copy",
        name: "Casey Copy",
        email: "casey@example.com",
        routingOrder: 99,
      },
    ],
    fields: [signatureField("one"), signatureField("two", 1, 0.5)],
    actor: { userId: company.ownerId },
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const signers = sent.recipients.filter((recipient) => recipient.role === "signer");
  assert.ok(signers.every((recipient) => recipient.status === "sent"));
  assert.ok(signers.every((recipient) => /^[a-f0-9]{64}$/.test(recipient.tokenHash ?? "")));
  const copy = sent.recipients.find((recipient) => recipient.role === "copy");
  assert.ok(copy);
  assert.equal(copy.status, "waiting");
  assert.equal(copy.tokenHash, null);
  assert.equal(copy.lastDeliveryStatus, "pending");
});

test("decline closes the whole request and invalidates every active signer link", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({
    company,
    recipients: [signer("one", "alice@example.com"), signer("two", "bob@example.com")],
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const tokenOne = await installKnownToken(sent.recipients[0].id);
  const tokenTwo = await installKnownToken(sent.recipients[1].id);
  await declineSignatureRecipient({
    token: tokenOne,
    reason: "Terms are not acceptable",
    ipAddress: "203.0.113.9",
  });
  const declined = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: sent.envelope.id,
  });
  assert.equal(declined.envelope.status, "declined");
  assert.equal(declined.envelope.declineReason, "Terms are not acceptable");
  assert.ok(declined.recipients.every((recipient) => recipient.tokenHash === null));
  assert.equal(await lookupSignatureRecipientByToken({ token: tokenOne }), null);
  assert.equal(await lookupSignatureRecipientByToken({ token: tokenTwo }), null);
  assert.equal(
    (
      await verifySignatureEventChain({
        companyId: company.id,
        envelopeId: sent.envelope.id,
      })
    ).valid,
    true,
  );
});

test("void and expiration are terminal, revoke tokens, and preserve the evidence chain", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  const voided = await voidSignatureEnvelope({
    companyId: company.id,
    envelopeId: sent.envelope.id,
    reason: "Customer requested cancellation",
    actor: { userId: company.ownerId },
  });
  assert.equal(voided.envelope.status, "voided");
  assert.equal(await lookupSignatureRecipientByToken({ token }), null);
  await assert.rejects(
    voidSignatureEnvelope({
      companyId: company.id,
      envelopeId: sent.envelope.id,
      actor: { userId: company.ownerId },
    }),
    SigningConflictError,
  );

  const expiringDraft = await createDraft({ company });
  const expiring = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: expiringDraft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const expiringToken = await installKnownToken(expiring.recipients[0].id);
  const yesterday = new Date(Date.now() - 86_400_000);
  await AppDataSource.getRepository(SignatureEnvelope).update(
    { id: expiring.envelope.id },
    { expiresAt: yesterday },
  );
  assert.equal(await expireSignatureEnvelopes({ companyId: company.id }), 1);
  const expired = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: expiring.envelope.id,
  });
  assert.equal(expired.envelope.status, "expired");
  assert.equal(await lookupSignatureRecipientByToken({ token: expiringToken }), null);
});

test("AI signing grants are company-scoped, rank ordered, contextual, and never authorize signing", async () => {
  const company = await fixtureCompany();
  const otherCompany = await fixtureCompany();
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Avery Contracts",
    slug: testId("avery").replace(/_/g, "-"),
    role: "Contracts manager",
    soulBody: "",
  });
  await upsertSigningGrant({
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "draft",
  });
  assert.equal(
    await hasSigningAccess({
      companyId: company.id,
      employeeId: employee.id,
      requiredAccess: "read",
    }),
    true,
  );
  assert.equal(
    await hasSigningAccess({
      companyId: company.id,
      employeeId: employee.id,
      requiredAccess: "send",
    }),
    false,
  );
  assert.equal(
    await hasSigningAccess({
      companyId: otherCompany.id,
      employeeId: employee.id,
      requiredAccess: "read",
    }),
    false,
  );
  const context = await composeSigningContext({
    companyId: company.id,
    employeeId: employee.id,
  });
  assert.match(context, /prepare new drafts/);
  assert.match(
    context,
    /cannot read the source PDF attached to an envelope or edit an existing draft/,
  );
  assert.match(context, /must never consent, draw, type, or submit a signature/);
  await upsertSigningGrant({
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "send",
  });
  const sendContext = await composeSigningContext({
    companyId: company.id,
    employeeId: employee.id,
  });
  assert.match(sendContext, /invitations or reminders that contact customers/);
  assert.match(sendContext, /voiding is irreversible/);
  assert.match(sendContext, /explicitly calls for it/);
  assert.equal(
    await deleteSigningGrant({ companyId: otherCompany.id, employeeId: employee.id }),
    false,
  );
  assert.equal(await deleteSigningGrant({ companyId: company.id, employeeId: employee.id }), true);
  assert.equal(await composeSigningContext({ companyId: company.id, employeeId: employee.id }), "");
});

test("company scoping hides envelopes and prevents cross-company mutations", async () => {
  const company = await fixtureCompany();
  const otherCompany = await fixtureCompany();
  const draft = await createDraft({ company });
  await assert.rejects(
    getSignatureEnvelopeDetail({
      companyId: otherCompany.id,
      envelopeId: draft.envelope.id,
    }),
    /not found/i,
  );
  await assert.rejects(
    sendSignatureEnvelope({
      companyId: otherCompany.id,
      envelopeId: draft.envelope.id,
      actor: { userId: otherCompany.ownerId },
    }),
    /not found/i,
  );
});

test("raw drawn-signature data URLs complete and embed without exposing image bytes in the public DTO", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({ company });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  // One transparent PNG pixel; raw data URL is the browser's canvas contract.
  const drawn =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X6sJ5wAAAABJRU5ErkJggg==";
  const result = await quietly(() =>
    completeSignatureRecipient({
      token,
      consent: true,
      values: [{ fieldId: sent.fields[0].id, value: drawn, type: "signature" }],
    }),
  );
  assert.equal(result.completed, true);
  const receipt = await lookupSignatureRecipientByToken({ token });
  assert.ok(receipt);
  assert.equal("valueJson" in receipt.fields[0], false);
  assert.deepEqual(receipt.fields[0].value, { kind: "drawn", dataUrl: drawn });
  const completed = await resolvePublicSignatureDocument({ token, variant: "completed" });
  assert.equal(
    (await PDFDocument.load(await fs.promises.readFile(completed.path))).getPageCount(),
    2,
  );
});

test("fully decoded JPEG signatures accept small canvases and the exact pixel boundary", async () => {
  for (const [width, height] of [
    [20, 10],
    [4_000, 1_000],
  ] as const) {
    const company = await fixtureCompany();
    const draft = await createDraft({ company });
    const sent = await quietly(() =>
      sendSignatureEnvelope({
        companyId: company.id,
        envelopeId: draft.envelope.id,
        actor: { userId: company.ownerId },
      }),
    );
    const token = await installKnownToken(sent.recipients[0].id);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "black";
    context.lineWidth = Math.max(1, height * 0.02);
    context.beginPath();
    context.moveTo(width * 0.025, height * 0.5);
    context.bezierCurveTo(
      width * 0.225,
      height * 0.1,
      width * 0.775,
      height * 0.9,
      width * 0.975,
      height * 0.5,
    );
    context.stroke();
    const jpeg = canvas.toBuffer("image/jpeg", 85);
    const drawn = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

    const result = await quietly(() =>
      completeSignatureRecipient({
        token,
        consent: true,
        values: { [sent.fields[0].id]: drawn },
      }),
    );

    assert.equal(result.completed, true);
    const receipt = await lookupSignatureRecipientByToken({ token });
    assert.equal(receipt?.recipient.status, "completed");
    assert.deepEqual(receipt?.fields[0].value, { kind: "drawn", dataUrl: drawn });
  }
});

test("malformed PNG and JPEG signatures roll back consent, fields, and recipient completion", async () => {
  const company = await fixtureCompany();
  const draft = await createDraft({
    company,
    routingMode: "ordered",
    recipients: [signer("one", "alice@example.com", 0), signer("two", "bob@example.com", 1)],
  });
  const sent = await quietly(() =>
    sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: company.ownerId },
    }),
  );
  const token = await installKnownToken(sent.recipients[0].id);
  const firstField = sent.fields.find((field) => field.recipientId === sent.recipients[0].id);
  assert.ok(firstField);
  const oversizedPng = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng);
  oversizedPng.writeUInt32BE(13, 8);
  oversizedPng.write("IHDR", 12, "ascii");
  oversizedPng.writeUInt32BE(100_000, 16);
  oversizedPng.writeUInt32BE(100_000, 20);
  const oversizedJpeg = Buffer.alloc(15);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0]).copy(oversizedJpeg);
  oversizedJpeg.writeUInt16BE(11, 4);
  oversizedJpeg[6] = 8;
  oversizedJpeg.writeUInt16BE(65_535, 7);
  oversizedJpeg.writeUInt16BE(65_535, 9);
  // A structurally complete one-component SOF segment with no scan data or
  // end marker. pdf-lib can embed these metadata-only bytes without decoding
  // the DCT stream, so this guards the real decoder used before any mutation.
  const truncatedJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  ]);
  const completeJpeg = createCanvas(20, 10).toBuffer("image/jpeg", 85);
  const jpegMissingEndMarker = completeJpeg.subarray(0, -2);
  const jpegWithTrailingPayload = Buffer.concat([
    completeJpeg,
    Buffer.from([0x00, 0x00, 0xff, 0xd9]),
  ]);
  const invalidImages = [
    "data:image/png;base64,AAAA",
    "data:image/jpeg;base64,AAAA",
    `data:image/png;base64,${oversizedPng.toString("base64")}`,
    `data:image/jpeg;base64,${oversizedJpeg.toString("base64")}`,
    `data:image/jpeg;base64,${truncatedJpeg.toString("base64")}`,
    `data:image/jpeg;base64,${jpegMissingEndMarker.toString("base64")}`,
    `data:image/jpeg;base64,${jpegWithTrailingPayload.toString("base64")}`,
  ];
  for (const malformed of invalidImages) {
    await assert.rejects(
      completeSignatureRecipient({
        token,
        consent: true,
        values: { [firstField.id]: malformed },
        ipAddress: "192.0.2.14",
        userAgent: "Malformed image regression",
      }),
      (error: unknown) =>
        error instanceof SigningValidationError &&
        /image is invalid|must be at most/i.test(error.message),
    );
  }

  const unchanged = await getSignatureEnvelopeDetail({
    companyId: company.id,
    envelopeId: sent.envelope.id,
  });
  assert.equal(unchanged.envelope.status, "sent");
  assert.equal(unchanged.recipients[0].status, "sent");
  assert.equal(unchanged.recipients[0].consentedAt, null);
  assert.equal(unchanged.recipients[0].completedAt, null);
  assert.equal(unchanged.recipients[1].status, "waiting");
  assert.equal(unchanged.recipients[1].tokenHash, null);
  assert.ok(unchanged.fields.every((field) => field.value === null));
  assert.ok(
    await lookupSignatureRecipientByToken({ token }),
    "the valid bearer link remains usable",
  );
  assert.equal(
    unchanged.events.some(
      (event) => event.type === "recipient_consented" || event.type === "recipient_completed",
    ),
    false,
  );
});
