import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Attachment } from "../../db/entities/Attachment.js";
import { Company } from "../../db/entities/Company.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { companyDir } from "../paths.js";
import {
  MailAttachmentError,
  type MailAttachmentTransport,
  fetchMailAttachmentBytes,
  importMailAttachment,
  parseMailAttachments,
  summarizeMailAttachments,
} from "./attachments.js";

/**
 * Opening a file that arrived on an email.
 *
 * The Gmail calls are stubbed through the transport seam so the interesting
 * parts — which attachment a positional index resolves to after Gmail
 * reissues its ids, and what the employee ends up holding — are covered
 * without a network or an OAuth token.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const METAS = [
  { partId: "1.1", attachmentId: "stale-a", filename: "FIF_2026.pdf", mimeType: "application/pdf", size: 12 },
  { partId: "1.2", attachmentId: "stale-b", filename: "notes.txt", mimeType: "text/plain", size: 5 },
];

function transport(options: {
  /** Attachment parts as Gmail reports them on the fresh fetch. */
  current?: Array<{ partId?: string; attachmentId: string }>;
  bytesById?: Record<string, Buffer>;
  onFetchMessage?: () => void;
} = {}): MailAttachmentTransport {
  const current = options.current ?? [
    { partId: "1.1", attachmentId: "fresh-a" },
    { partId: "1.2", attachmentId: "fresh-b" },
  ];
  const bytesById = options.bytesById ?? {
    "fresh-a": Buffer.from("%PDF-1.7 fake form"),
    "fresh-b": Buffer.from("hello"),
  };
  return {
    accessToken: async () => "test-token",
    fetchMessage: async () => {
      options.onFetchMessage?.();
      return {
        id: "gmail-message",
        threadId: "gmail-thread",
        payload: {
          mimeType: "multipart/mixed",
          parts: current.map((part, index) => ({
            partId: part.partId,
            filename: METAS[index]?.filename ?? `file-${index}`,
            mimeType: METAS[index]?.mimeType ?? "application/octet-stream",
            body: { attachmentId: part.attachmentId, size: 10 },
          })),
        },
      } as never;
    },
    fetchAttachment: async (_token, _messageId, attachmentId) => {
      const bytes = bytesById[attachmentId];
      return bytes ? { data: bytes.toString("base64url"), size: bytes.length } : {};
    },
  };
}

async function fixture(attachmentsJson = JSON.stringify(METAS)): Promise<{
  company: Company;
  account: MailAccount;
  message: MailMessage;
}> {
  const company = await insert(Company, {
    name: "Attachment Co",
    slug: `attachment-co-${randomUUID()}`,
    ownerId: "owner-1",
  });
  const account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "ap@example.com",
  });
  const message = await insert(MailMessage, {
    companyId: company.id,
    accountId: account.id,
    threadId: randomUUID(),
    gmailMessageId: "gmail-message",
    gmailThreadId: "gmail-thread",
    subject: "New supplier form",
    attachmentsJson,
  });
  return { company, account, message };
}

describe("mail attachment metadata", () => {
  test("summaries carry the index the read tool takes", () => {
    const summaries = summarizeMailAttachments(JSON.stringify(METAS));
    assert.deepEqual(summaries, [
      { index: 0, filename: "FIF_2026.pdf", mimeType: "application/pdf", size: 12 },
      { index: 1, filename: "notes.txt", mimeType: "text/plain", size: 5 },
    ]);
  });

  test("malformed or non-array metadata reads as no attachments", () => {
    assert.deepEqual(parseMailAttachments("not json"), []);
    assert.deepEqual(parseMailAttachments('{"filename":"x"}'), []);
    assert.deepEqual(summarizeMailAttachments(""), []);
  });
});

describe("fetching an attachment's bytes", () => {
  test("resolves the current Gmail id by position, not the stored one", async () => {
    const { account, message } = await fixture();
    const requested: string[] = [];
    const seam = transport();
    const spied: MailAttachmentTransport = {
      ...seam,
      fetchAttachment: async (token, messageId, attachmentId) => {
        requested.push(attachmentId);
        return seam.fetchAttachment(token, messageId, attachmentId);
      },
    };

    const { meta, bytes } = await fetchMailAttachmentBytes(account, message, 0, spied);

    assert.deepEqual(requested, ["fresh-a"], "the stale stored id is not what we ask Gmail for");
    assert.equal(meta.filename, "FIF_2026.pdf");
    assert.equal(bytes.toString(), "%PDF-1.7 fake form");
  });

  test("falls back to partId when Gmail reorders the parts", async () => {
    const { account, message } = await fixture();
    const seam = transport({
      // Gmail returns the parts in a different order and the positional
      // lookup lands on the wrong file; partId is the tie-breaker.
      current: [{ partId: "1.2", attachmentId: "fresh-b" }],
      bytesById: { "fresh-a": Buffer.from("form"), "fresh-b": Buffer.from("hello") },
    });

    const { bytes } = await fetchMailAttachmentBytes(account, message, 1, seam);

    assert.equal(bytes.toString(), "hello");
  });

  test("falls back to the stored id when the fresh payload has no attachments", async () => {
    const { account, message } = await fixture();
    const seam = transport({
      current: [],
      bytesById: { "stale-a": Buffer.from("still here") },
    });

    const { bytes } = await fetchMailAttachmentBytes(account, message, 0, seam);

    assert.equal(bytes.toString(), "still here");
  });

  test("an out-of-range index fails before Gmail is called at all", async () => {
    const { account, message } = await fixture();
    let fetched = false;
    const seam = transport({ onFetchMessage: () => (fetched = true) });

    await assert.rejects(
      () => fetchMailAttachmentBytes(account, message, 7, seam),
      (error: unknown) => {
        assert.ok(error instanceof MailAttachmentError);
        assert.equal(error.status, 404);
        assert.match(error.message, /this email has 2/);
        return true;
      },
    );
    assert.equal(fetched, false);
  });

  test("a message with no attachments says so plainly", async () => {
    const { account, message } = await fixture("[]");

    await assert.rejects(
      () => fetchMailAttachmentBytes(account, message, 0, transport()),
      /no attachments/i,
    );
  });

  test("an empty Gmail response is an error, not an empty file", async () => {
    const { account, message } = await fixture();
    const seam = transport({ bytesById: {} });

    await assert.rejects(
      () => fetchMailAttachmentBytes(account, message, 0, seam),
      (error: unknown) => {
        assert.ok(error instanceof MailAttachmentError);
        assert.equal(error.status, 404);
        return true;
      },
    );
  });
});

describe("importing an attachment into the chat store", () => {
  test("writes the bytes to disk and records a company-scoped row", async () => {
    const { company, account, message } = await fixture();

    const { attachment, bytes } = await importMailAttachment({
      companyId: company.id,
      account,
      message,
      index: 0,
      transport: transport(),
    });

    assert.equal(attachment.companyId, company.id);
    assert.equal(attachment.filename, "FIF_2026.pdf");
    assert.equal(attachment.mimeType, "application/pdf");
    assert.equal(Number(attachment.sizeBytes), bytes.length);
    assert.equal(
      attachment.uploadedByUserId,
      null,
      "an imported file has no human uploader — provenance is the audit log",
    );
    assert.equal(attachment.messageId, null, "not yet bound to any chat turn");

    const abs = path.join(companyDir(company.slug), "attachments", attachment.storageKey);
    assert.equal(fs.readFileSync(abs).toString(), "%PDF-1.7 fake form");
    fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
  });

  test("importing twice yields distinct rows rather than clobbering the first", async () => {
    const { company, account, message } = await fixture();

    const first = await importMailAttachment({
      companyId: company.id,
      account,
      message,
      index: 0,
      transport: transport(),
    });
    const second = await importMailAttachment({
      companyId: company.id,
      account,
      message,
      index: 0,
      transport: transport(),
    });

    assert.notEqual(first.attachment.id, second.attachment.id);
    assert.notEqual(first.attachment.storageKey, second.attachment.storageKey);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 2);
    fs.rmSync(companyDir(company.slug), { recursive: true, force: true });
  });

  test("refuses a file larger than the attachment cap", async () => {
    const { company, account, message } = await fixture();
    const seam = transport({
      bytesById: { "fresh-a": Buffer.alloc(26 * 1024 * 1024, 1) },
    });

    await assert.rejects(
      () =>
        importMailAttachment({
          companyId: company.id,
          account,
          message,
          index: 0,
          transport: seam,
        }),
      (error: unknown) => {
        assert.ok(error instanceof MailAttachmentError);
        assert.equal(error.status, 413);
        assert.match(error.message, /FIF_2026\.pdf/);
        return true;
      },
    );
    assert.equal(
      await AppDataSource.getRepository(Attachment).count(),
      0,
      "a refused import leaves no half-created row",
    );
  });

  test("an unknown company is refused before anything is written", async () => {
    const { account, message } = await fixture();

    await assert.rejects(
      () =>
        importMailAttachment({
          companyId: "co_missing",
          account,
          message,
          index: 0,
          transport: transport(),
        }),
      /Company not found/,
    );
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 0);
  });
});
