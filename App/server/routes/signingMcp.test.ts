import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";
import { PDFDocument } from "pdf-lib";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import {
  EmployeeSigningGrant,
  type SigningAccessLevel,
} from "../db/entities/EmployeeSigningGrant.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Resource } from "../db/entities/Resource.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { SignatureEvent } from "../db/entities/SignatureEvent.js";
import { SignatureRecipient } from "../db/entities/SignatureRecipient.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { companyDir, ensureDir } from "../services/paths.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;

const SIGNING_TOOLS = [
  "list_signature_envelopes",
  "get_signature_envelope",
  "draft_signature_envelope",
  "send_signature_envelope",
  "remind_signature_recipient",
  "void_signature_envelope",
] as const;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Acme Agreements",
    slug: `signing-mcp-${randomUUID()}`,
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Contract coordinator",
    slug: "contract-coordinator",
    role: "Contract coordinator",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id);
});

afterEach(async () => {
  if (company?.slug) {
    await fs.promises.rm(companyDir(company.slug), { recursive: true, force: true });
  }
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

type ApiResponse<T = Record<string, unknown>> = {
  status: number;
  body: T & { error?: string };
};

async function aiCall<T = Record<string, unknown>>(
  tool: string,
  body: unknown = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return {
    status: response.status,
    body: parsed as T & { error?: string },
  };
}

async function grantSigning(accessLevel: SigningAccessLevel): Promise<EmployeeSigningGrant> {
  const repository = AppDataSource.getRepository(EmployeeSigningGrant);
  let grant = await repository.findOneBy({ employeeId: employee.id });
  if (!grant) {
    grant = repository.create({ companyId: company.id, employeeId: employee.id, accessLevel });
  } else {
    grant.accessLevel = accessLevel;
  }
  return repository.save(grant);
}

async function createPdfResource(withGrant = true): Promise<Resource> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawText("Mutual non-disclosure agreement", { x: 48, y: 730, size: 18 });
  const bytes = Buffer.from(await pdf.save());
  const storageKey = `${randomUUID()}.pdf`;
  const root = path.join(companyDir(company.slug), "resources");
  ensureDir(root);
  await fs.promises.writeFile(path.join(root, storageKey), bytes);
  const resource = await insert(Resource, {
    companyId: company.id,
    title: "Mutual NDA",
    slug: "mutual-nda",
    sourceKind: "pdf",
    sourceFilename: "mutual-nda.pdf",
    storageKey,
    summary: "A mutual NDA.",
    bodyText: "Mutual non-disclosure agreement",
    tags: "legal",
    bytes: bytes.length,
    status: "ready",
    errorMessage: "",
    createdById: "owner-1",
    createdByEmployeeId: null,
  });
  if (withGrant) {
    await insert(EmployeeResourceGrant, {
      employeeId: employee.id,
      resourceId: resource.id,
      accessLevel: "read",
    });
  }
  return resource;
}

function draftPayload(resource: Resource) {
  return {
    resourceSlug: resource.slug,
    title: "Mutual NDA — signature",
    message: "Please review and sign.",
    routingMode: "parallel",
    recipients: [
      {
        name: "Ada Customer",
        email: "ada@example.test",
        role: "signer",
        fields: [
          {
            type: "signature",
            label: "Customer signature",
            pageNumber: 1,
            x: 0.1,
            y: 0.75,
            width: 0.3,
            height: 0.08,
          },
        ],
      },
    ],
  };
}

async function createDraft(): Promise<{
  envelope: Record<string, unknown>;
  recipients: Array<Record<string, unknown>>;
  fields: Array<Record<string, unknown>>;
}> {
  const resource = await createPdfResource();
  const response = await aiCall<{
    envelope: Record<string, unknown>;
    recipients: Array<Record<string, unknown>>;
    fields: Array<Record<string, unknown>>;
  }>("draft_signature_envelope", draftPayload(resource));
  assert.equal(response.status, 200, response.body.error);
  return response.body;
}

describe("AI Employee Signing Grants", () => {
  test("marks the complete signing surface grant-dead and denies reads without a Grant", async () => {
    const dead = await deadToolNames(employee.id);
    for (const tool of SIGNING_TOOLS) {
      assert.equal(dead.has(tool), true, `${tool} should be grant-dead`);
    }

    const response = await aiCall("list_signature_envelopes");
    assert.equal(response.status, 403);
    assert.match(response.body.error ?? "", /No grant/);
  });

  test("enforces read < draft < send at the route seam", async () => {
    await grantSigning("read");
    let dead = await deadToolNames(employee.id);
    assert.equal(dead.has("list_signature_envelopes"), false);
    assert.equal(dead.has("get_signature_envelope"), false);
    assert.equal(dead.has("draft_signature_envelope"), true);
    assert.equal(dead.has("send_signature_envelope"), true);
    assert.equal(dead.has("remind_signature_recipient"), true);
    assert.equal(dead.has("void_signature_envelope"), true);
    const list = await aiCall<{ accessLevel: string; envelopes: unknown[] }>(
      "list_signature_envelopes",
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.accessLevel, "read");
    assert.deepEqual(list.body.envelopes, []);

    const resource = await createPdfResource();
    const draft = await aiCall("draft_signature_envelope", draftPayload(resource));
    assert.equal(draft.status, 403);
    assert.match(draft.body.error ?? "", /needs the "draft" signing access level/);

    await grantSigning("draft");
    dead = await deadToolNames(employee.id);
    assert.equal(dead.has("list_signature_envelopes"), false);
    assert.equal(dead.has("get_signature_envelope"), false);
    assert.equal(dead.has("draft_signature_envelope"), false);
    assert.equal(dead.has("send_signature_envelope"), true);
    assert.equal(dead.has("remind_signature_recipient"), true);
    assert.equal(dead.has("void_signature_envelope"), true);
    const send = await aiCall("send_signature_envelope", {
      envelopeId: randomUUID(),
      expectedUpdatedAt: new Date().toISOString(),
    });
    assert.equal(send.status, 403);
    assert.match(send.body.error ?? "", /needs the "send" signing access level/);

    await grantSigning("send");
    dead = await deadToolNames(employee.id);
    for (const tool of SIGNING_TOOLS) assert.equal(dead.has(tool), false, tool);
  });
});

describe("AI-native signature envelopes", () => {
  test("drafts from a granted PDF Resource without exposing private signing data", async () => {
    await grantSigning("draft");
    const result = await createDraft();

    assert.equal(result.envelope.status, "draft");
    assert.equal(result.envelope.createdByEmployeeId, employee.id);
    assert.equal("originalStorageKey" in result.envelope, false);
    assert.equal("completedStorageKey" in result.envelope, false);
    assert.equal("documentText" in result.envelope, false);
    assert.equal(result.recipients.length, 1);
    assert.equal("tokenHash" in result.recipients[0], false);
    assert.equal(result.fields.length, 1);
    assert.equal("value" in result.fields[0], false);
    assert.equal("valueJson" in result.fields[0], false);

    const list = await aiCall<{ envelopes: Array<Record<string, unknown>> }>(
      "list_signature_envelopes",
    );
    assert.equal(list.status, 200, list.body.error);
    assert.equal(list.body.envelopes.length, 1);
    assert.equal("documentText" in list.body.envelopes[0], false, "list rows must stay compact");

    const envelopeId = String(result.envelope.id);
    const envelope = await AppDataSource.getRepository(SignatureEnvelope).findOneByOrFail({
      id: envelopeId,
      companyId: company.id,
    });
    assert.ok(
      fs.existsSync(
        path.join(companyDir(company.slug), "signature-envelopes", envelope.originalStorageKey),
      ),
    );
    const createdEvent = await AppDataSource.getRepository(SignatureEvent).findOneByOrFail({
      companyId: company.id,
      envelopeId,
      type: "envelope_created",
    });
    assert.equal(createdEvent.actorKind, "ai");
    assert.equal(createdEvent.actorId, employee.id);

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      companyId: company.id,
      action: "signature.envelope.create",
    });
    assert.equal(audit.actorKind, "ai");
    assert.equal(audit.actorEmployeeId, employee.id);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: employee.id }),
      1,
    );
  });

  test("requires a separate Resource Grant before copying a PDF into signing storage", async () => {
    await grantSigning("draft");
    const resource = await createPdfResource(false);

    const response = await aiCall("draft_signature_envelope", draftPayload(resource));

    assert.equal(response.status, 409);
    assert.match(response.body.error ?? "", /cannot read that PDF Resource/);
    assert.equal(await AppDataSource.getRepository(SignatureEnvelope).count(), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 0);
  });

  test("send, remind, and void require Send access and preserve recipient-only signing", async () => {
    await grantSigning("draft");
    const draft = await createDraft();
    const envelopeId = String(draft.envelope.id);
    const recipientId = String(draft.recipients[0].id);

    const expectedUpdatedAt = String(draft.envelope.updatedAt);
    const denied = await aiCall("send_signature_envelope", { envelopeId, expectedUpdatedAt });
    assert.equal(denied.status, 403);
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 1);

    await grantSigning("send");
    const sent = await aiCall<{
      envelope: Record<string, unknown>;
      recipients: Array<Record<string, unknown>>;
    }>("send_signature_envelope", { envelopeId, expectedUpdatedAt });
    assert.equal(sent.status, 200, sent.body.error);
    assert.equal(sent.body.envelope.status, "sent");
    assert.equal("tokenHash" in sent.body.recipients[0], false);

    const storedRecipient = await AppDataSource.getRepository(SignatureRecipient).findOneByOrFail({
      id: recipientId,
      companyId: company.id,
    });
    assert.ok(storedRecipient.tokenHash, "the private recipient flow should hold a hashed token");
    assert.equal(storedRecipient.status, "sent");

    const reminded = await aiCall<{ recipients: Array<Record<string, unknown>> }>(
      "remind_signature_recipient",
      { envelopeId, recipientId },
    );
    assert.equal(reminded.status, 200, reminded.body.error);
    assert.equal(reminded.body.recipients[0].reminderCount, 1);
    assert.equal("tokenHash" in reminded.body.recipients[0], false);

    const voided = await aiCall<{ envelope: Record<string, unknown> }>("void_signature_envelope", {
      envelopeId,
      reason: "Agreement superseded by a newer version.",
    });
    assert.equal(voided.status, 200, voided.body.error);
    assert.equal(voided.body.envelope.status, "voided");
    assert.equal(
      (await AppDataSource.getRepository(SignatureRecipient).findOneByOrFail({ id: recipientId }))
        .tokenHash,
      null,
    );
    assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 4);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).countBy({ employeeId: employee.id }),
      4,
    );
  });

  test("publishes no tool capable of completing a recipient signature", async () => {
    const names = STATIC_TOOLS.map((tool) => tool.name);
    assert.equal(names.includes("complete_signature_recipient"), false);
    assert.equal(names.includes("sign_signature_envelope"), false);
    assert.deepEqual(
      names.filter((name) => name.includes("signature")),
      [...SIGNING_TOOLS],
    );

    const response = await aiCall("complete_signature_recipient", {
      envelopeId: randomUUID(),
      recipientId: randomUUID(),
    });
    assert.equal(response.status, 404);
  });
});
