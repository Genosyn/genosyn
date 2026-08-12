import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { PDFDocument } from "pdf-lib";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { SignatureField } from "../db/entities/SignatureField.js";
import { SignatureRecipient } from "../db/entities/SignatureRecipient.js";
import { User } from "../db/entities/User.js";
import {
  createSignatureEnvelopeFromUpload,
  generateSignatureRecipientToken,
  hashSignatureRecipientToken,
  injectSigningFinalizationFailureForTests,
  resolveSigningStoragePath,
  sendSignatureEnvelope,
  sha256Buffer,
} from "../services/signing.js";
import { companyDir } from "../services/paths.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { publicSignaturesRouter, publicSigningSecurityHeaders } from "./publicSignatures.js";
import { signaturesRouter } from "./signatures.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let company: Company;

const signingRouteTestErrorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
  const candidate = error as { status?: number; statusCode?: number };
  const status = candidate.statusCode ?? candidate.status ?? 500;
  res.status(status).json({ error: status === 413 ? "Request body is too large" : "Test error" });
};

before(async () => {
  await initTestDb();
  const app = express();
  app.use("/api/sign", publicSigningSecurityHeaders);
  app.use("/sign", publicSigningSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/sign", publicSignaturesRouter);
  app.get("/sign/:token", (_req, res) => res.type("html").send("signing app"));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", signaturesRouter);
  app.use(signingRouteTestErrorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: "signing-owner@example.com",
    name: "Signing owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Northstar Agreements",
    slug: `signing-http-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
});

afterEach(async () => {
  injectSigningFinalizationFailureForTests(null);
  if (company?.slug) {
    await fs.promises.rm(companyDir(company.slug), { recursive: true, force: true });
  }
});

async function jsonCall<T = Record<string, unknown>>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

async function seedActiveEnvelope(): Promise<{
  envelope: SignatureEnvelope;
  recipient: SignatureRecipient;
  field: SignatureField;
  token: string;
}> {
  const token = generateSignatureRecipientToken();
  const envelope = await insert(SignatureEnvelope, {
    companyId: company.id,
    customerId: null,
    title: "Mutual NDA",
    message: "Please sign.",
    status: "sent",
    routingMode: "parallel",
    originalFilename: "mutual-nda.pdf",
    originalMimeType: "application/pdf",
    originalSizeBytes: 120,
    originalStorageKey: "private-original.pdf",
    originalPageCount: 1,
    documentText: "CONFIDENTIAL EXTRACTED TEXT",
    originalSha256: "a".repeat(64),
    completedStorageKey: null,
    completedSizeBytes: 0,
    completedSha256: "",
    customerContractId: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    sentAt: new Date(),
    completedAt: null,
    declinedAt: null,
    declineReason: "",
    voidedAt: null,
    voidReason: "",
    expiredAt: null,
    createdByUserId: owner.id,
    createdByEmployeeId: null,
  });
  const recipient = await insert(SignatureRecipient, {
    companyId: company.id,
    envelopeId: envelope.id,
    role: "signer",
    name: "Ada Lovelace",
    email: "ada@example.com",
    routingOrder: 0,
    status: "sent",
    tokenHash: hashSignatureRecipientToken(token),
    lastDeliveryStatus: "sent",
    lastDeliveryError: "",
    lastDeliveredAt: new Date(),
    reminderCount: 0,
    viewedAt: null,
    consentedAt: null,
    completedAt: null,
    declinedAt: null,
    declineReason: "",
    ipAddress: "",
    userAgent: "",
  });
  const field = await insert(SignatureField, {
    companyId: company.id,
    envelopeId: envelope.id,
    recipientId: recipient.id,
    type: "signature",
    label: "Signature",
    placeholder: "",
    required: true,
    pageNumber: 1,
    x: 0.1,
    y: 0.7,
    width: 0.3,
    height: 0.08,
    valueJson: "null",
    completedAt: null,
    sortOrder: 0,
  });
  return { envelope, recipient, field, token };
}

async function materializeOriginal(envelope: SignatureEnvelope): Promise<void> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText("Download throttle fixture", { x: 48, y: 730 });
  const bytes = Buffer.from(await pdf.save());
  const storagePath = resolveSigningStoragePath(company.slug, envelope.originalStorageKey);
  assert.ok(storagePath);
  await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.promises.writeFile(storagePath, bytes, { mode: 0o600 });
  envelope.originalSizeBytes = bytes.byteLength;
  envelope.originalSha256 = sha256Buffer(bytes);
  await AppDataSource.getRepository(SignatureEnvelope).save(envelope);
}

async function seedRecoverableEnvelope(): Promise<{
  envelope: SignatureEnvelope;
  recipient: SignatureRecipient;
  field: SignatureField;
  token: string;
}> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText("Recovery fixture", { x: 48, y: 730 });
  const bytes = Buffer.from(await pdf.save());
  const uploadPath = path.join(companyDir(company.slug), `recovery-${randomUUID()}.pdf`);
  await fs.promises.mkdir(path.dirname(uploadPath), { recursive: true });
  await fs.promises.writeFile(uploadPath, bytes);
  const draft = await createSignatureEnvelopeFromUpload({
    company,
    file: {
      fieldname: "file",
      originalname: "recovery.pdf",
      encoding: "7bit",
      mimetype: "application/pdf",
      size: bytes.length,
      destination: path.dirname(uploadPath),
      filename: path.basename(uploadPath),
      path: uploadPath,
      buffer: bytes,
      stream: fs.createReadStream(uploadPath),
    },
    title: "Recovery agreement",
    recipients: [
      {
        key: "signer",
        role: "signer",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    ],
    fields: [
      {
        recipientKey: "signer",
        type: "signature",
        label: "Signature",
        required: true,
        pageNumber: 1,
        x: 0.1,
        y: 0.7,
        width: 0.3,
        height: 0.08,
      },
    ],
    actor: { userId: owner.id },
  });
  const originalLog = console.log;
  console.log = () => undefined;
  let sent: Awaited<ReturnType<typeof sendSignatureEnvelope>>;
  try {
    sent = await sendSignatureEnvelope({
      companyId: company.id,
      envelopeId: draft.envelope.id,
      actor: { userId: owner.id },
    });
  } finally {
    console.log = originalLog;
  }
  const token = generateSignatureRecipientToken();
  await AppDataSource.getRepository(SignatureRecipient).update(
    { id: sent.recipients[0].id },
    { tokenHash: hashSignatureRecipientToken(token) },
  );
  return {
    envelope: sent.envelope,
    recipient: sent.recipients[0],
    field: sent.fields[0],
    token,
  };
}

describe("signature envelope HTTP routes", () => {
  test("accepts a multipart PDF and returns only safe, numeric metadata", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText("Service agreement", { x: 48, y: 730 });
    const bytes = await pdf.save();
    const uploadBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(uploadBytes).set(bytes);
    const form = new FormData();
    form.append("file", new Blob([uploadBytes], { type: "application/pdf" }), "service-🚀.pdf");
    form.append("title", "Service agreement");
    form.append("routingMode", "ordered");
    form.append("customerId", "");
    form.append("message", "Please review.");
    form.append("expiresAt", "");

    const response = await fetch(`${baseUrl}/api/companies/${company.id}/signature-envelopes`, {
      method: "POST",
      body: form,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      envelope: Record<string, unknown>;
      recipients: unknown[];
    };
    assert.equal(body.envelope.title, "Service agreement");
    assert.equal(body.envelope.routingMode, "ordered");
    assert.equal(typeof body.envelope.originalSizeBytes, "number");
    assert.equal("originalStorageKey" in body.envelope, false);
    assert.equal("completedStorageKey" in body.envelope, false);
    assert.equal("documentText" in body.envelope, false);
    assert.deepEqual(body.recipients, []);
  });

  test("persists empty and partially entered draft recipients but blocks send", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText("Incremental draft", { x: 48, y: 730 });
    const bytes = await pdf.save();
    const uploadBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(uploadBytes).set(bytes);
    const form = new FormData();
    form.append("file", new Blob([uploadBytes], { type: "application/pdf" }), "draft.pdf");
    form.append("title", "Incremental draft");

    const createdResponse = await fetch(
      `${baseUrl}/api/companies/${company.id}/signature-envelopes`,
      { method: "POST", body: form },
    );
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      envelope: { id: string };
    };
    const endpoint = `/api/companies/${company.id}/signature-envelopes/${created.envelope.id}`;

    const metadataOnly = await jsonCall<{
      envelope: { title: string; updatedAt: string };
      recipients: unknown[];
      fields: unknown[];
    }>("PATCH", endpoint, {
      title: "Metadata saved first",
      recipients: [],
      fields: [],
    });
    assert.equal(metadataOnly.status, 200);
    assert.equal(metadataOnly.body.envelope.title, "Metadata saved first");
    assert.deepEqual(metadataOnly.body.recipients, []);
    assert.deepEqual(metadataOnly.body.fields, []);

    const partial = await jsonCall<{
      envelope: { updatedAt: string };
      recipients: Array<{ name: string; email: string }>;
      fields: unknown[];
    }>("PATCH", endpoint, {
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
    });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.recipients[0].name, "");
    assert.equal(partial.body.recipients[0].email, "ada@");
    assert.deepEqual(partial.body.fields, []);

    const send = await jsonCall<{ error: string }>("POST", `${endpoint}/send`, {
      expectedUpdatedAt: partial.body.envelope.updatedAt,
    });
    assert.equal(send.status, 400);
    assert.equal(send.body.error, "Recipient 1 needs a name before sending");
    const after = await AppDataSource.getRepository(SignatureEnvelope).findOneByOrFail({
      id: created.envelope.id,
    });
    assert.equal(after.status, "draft");
  });

  test("returns every AI employee and reserves access mutations for admins", async () => {
    const employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Nia",
      slug: "nia",
      role: "Contract coordinator",
      soulBody: "",
    });
    const initial = await jsonCall<Array<{ employee: { id: string }; grant: null }>>(
      "GET",
      `/api/companies/${company.id}/signatures/ai-access`,
    );
    assert.equal(initial.status, 200);
    assert.equal(initial.body[0]?.employee.id, employee.id);
    assert.equal(initial.body[0]?.grant, null);

    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: company.id,
      userId: member.id,
      role: "member" as Role,
    });
    actingUserId = member.id;
    const forbidden = await jsonCall(
      "PUT",
      `/api/companies/${company.id}/signatures/ai-access/${employee.id}`,
      { accessLevel: "draft" },
    );
    assert.equal(forbidden.status, 403);

    actingUserId = owner.id;
    const granted = await jsonCall<{ accessLevel: string }>(
      "PUT",
      `/api/companies/${company.id}/signatures/ai-access/${employee.id}`,
      { accessLevel: "draft" },
    );
    assert.equal(granted.status, 200);
    assert.equal(granted.body.accessLevel, "draft");
  });
});

describe("public signature HTTP routes", () => {
  test("returns one generic response for malformed and unknown tokens", async () => {
    const malformed = await jsonCall<{ error: string }>("GET", "/api/sign/not-a-token");
    const unknown = await jsonCall<{ error: string }>("GET", `/api/sign/${"A".repeat(43)}`);
    assert.equal(malformed.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(malformed.body, unknown.body);
    assert.equal(malformed.body.error, "This signing link is invalid or expired");
    assert.equal(malformed.headers.get("cache-control"), "private, no-store");
    assert.equal(malformed.headers.get("pragma"), "no-cache");
    assert.equal(malformed.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  test("protects the public signing SPA shell from caches and crawlers", async () => {
    const response = await fetch(`${baseUrl}/sign/${"A".repeat(43)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  test("keeps parser errors private and non-indexable", async () => {
    const response = await fetch(`${baseUrl}/api/sign/${"A".repeat(43)}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_100_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  test("requires a bounded signer timezone offset and validates optional IANA timezone names", async () => {
    const { token } = await seedActiveEnvelope();
    for (const body of [
      { consent: true, values: [] },
      { consent: true, timezoneOffsetMinutes: 841, values: [] },
      {
        consent: true,
        timezoneOffsetMinutes: 0,
        timeZone: "Not/A_Timezone",
        values: [],
      },
    ]) {
      const response = await jsonCall("POST", `/api/sign/${token}/complete`, body);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
  });

  test("lets a completed signer safely resume interrupted document finalization", async () => {
    const { envelope, field, token } = await seedRecoverableEnvelope();
    injectSigningFinalizationFailureForTests(new Error("Injected public recovery failure"));
    const interrupted = await jsonCall("POST", `/api/sign/${token}/complete`, {
      consent: true,
      timezoneOffsetMinutes: 0,
      timeZone: "UTC",
      values: [{ fieldId: field.id, value: "Ada Lovelace", type: field.type }],
    });
    assert.equal(interrupted.status, 500);

    const receipt = await jsonCall<{
      envelope: { status: string; finalizationPending: boolean };
      recipient: { status: string };
    }>("GET", `/api/sign/${token}`);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.envelope.status, "in_progress");
    assert.equal(receipt.body.envelope.finalizationPending, true);
    assert.equal(receipt.body.recipient.status, "completed");

    injectSigningFinalizationFailureForTests(null);
    const recovered = await jsonCall<{ completed: boolean; envelopeId: string }>(
      "POST",
      `/api/sign/${token}/finalize`,
      {},
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.completed, true);
    assert.equal(recovered.body.envelopeId, envelope.id);

    const repeated = await jsonCall<{ completed: boolean }>(
      "POST",
      `/api/sign/${token}/finalize`,
      {},
    );
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.completed, true);
  });

  test("does not let an active signer invoke the finalization-only recovery action", async () => {
    const { recipient, token } = await seedActiveEnvelope();
    const response = await jsonCall<{ error: string }>("POST", `/api/sign/${token}/finalize`, {});
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "This signing link is invalid or expired");
    assert.equal(
      (await AppDataSource.getRepository(SignatureRecipient).findOneByOrFail({ id: recipient.id }))
        .status,
      "sent",
    );
  });

  test("projects a safe recipient DTO and records view evidence", async () => {
    const { recipient, token } = await seedActiveEnvelope();
    const detail = await jsonCall<{
      envelope: Record<string, unknown>;
      recipient: Record<string, unknown>;
      fields: Array<Record<string, unknown>>;
      sender: { companyName: string };
    }>("GET", `/api/sign/${token}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.sender.companyName, company.name);
    assert.equal(detail.body.envelope.title, "Mutual NDA");
    assert.equal("companyId" in detail.body.envelope, false);
    assert.equal("originalStorageKey" in detail.body.envelope, false);
    assert.equal("tokenHash" in detail.body.recipient, false);
    assert.equal("valueJson" in detail.body.fields[0], false);
    assert.equal(detail.headers.get("cache-control"), "private, no-store");

    const viewed = await jsonCall("POST", `/api/sign/${token}/view`, {});
    assert.equal(viewed.status, 200);
    const row = await AppDataSource.getRepository(SignatureRecipient).findOneByOrFail({
      id: recipient.id,
    });
    assert.equal(row.status, "viewed");
    assert.ok(row.viewedAt);
    assert.match(row.ipAddress, /127\.0\.0\.1/);
  });

  test("redacts stored field values after the recipient completes", async () => {
    const { envelope, recipient, field, token } = await seedActiveEnvelope();
    const rawValue = { kind: "typed", text: "TOP SECRET SIGNATURE VALUE" };
    field.valueJson = JSON.stringify(rawValue);
    await AppDataSource.getRepository(SignatureField).save(field);

    const active = await jsonCall<{ fields: Array<{ value: unknown }> }>(
      "GET",
      `/api/sign/${token}`,
    );
    assert.deepEqual(active.body.fields[0]?.value, rawValue);

    recipient.status = "completed";
    recipient.completedAt = new Date();
    field.completedAt = recipient.completedAt;
    envelope.status = "completed";
    envelope.completedAt = recipient.completedAt;
    await AppDataSource.getRepository(SignatureRecipient).save(recipient);
    await AppDataSource.getRepository(SignatureField).save(field);
    await AppDataSource.getRepository(SignatureEnvelope).save(envelope);

    const completed = await jsonCall<{ fields: Array<{ value: unknown }> }>(
      "GET",
      `/api/sign/${token}`,
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.body.fields[0]?.value, null);
    assert.equal(JSON.stringify(completed.body).includes("TOP SECRET SIGNATURE VALUE"), false);
  });

  test("persistently caps downloads for a validated recipient link", async () => {
    const { envelope, token } = await seedActiveEnvelope();
    await materializeOriginal(envelope);

    for (let attempt = 0; attempt < config.security.authRateLimit.maxAttempts; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/sign/${token}/document`);
      assert.equal(response.status, 200, `download ${attempt + 1} should be allowed`);
      assert.match(response.headers.get("content-type") ?? "", /^application\/pdf/);
      await response.arrayBuffer();
    }

    const limited = await fetch(`${baseUrl}/api/sign/${token}/document`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal(limited.headers.get("cache-control"), "private, no-store");
  });
});
