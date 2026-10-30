import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import type { DataRoom } from "../db/entities/DataRoom.js";
import { DataRoomGuest } from "../db/entities/DataRoomGuest.js";
import { DataRoomQuestion } from "../db/entities/DataRoomQuestion.js";
import { EmployeeDataRoomGrant } from "../db/entities/EmployeeDataRoomGrant.js";
import { EmployeeSigningGrant } from "../db/entities/EmployeeSigningGrant.js";
import { SignatureEnvelope } from "../db/entities/SignatureEnvelope.js";
import { SignatureRecipient } from "../db/entities/SignatureRecipient.js";
import { errorHandler } from "../middleware/error.js";
import { setDataRoomQueueAutoKickForTests } from "../services/dataRooms/queue.js";
import { createDataRoom } from "../services/dataRooms/rooms.js";
import {
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
  TOOL_PAGE_BUDGET_CHARS,
} from "../services/listPaging.js";
import { isTokenTainted, issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { isTaintSource } from "../services/taintPolicy.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * A data room's questions and the company's signature envelopes page like
 * every other list (`services/listPaging.ts`). The questions stopped at the
 * newest 200; the envelopes were all loaded, filtered in memory and cut at
 * 100, extracted PDF text included.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let company: Company;
let employee: AIEmployee;
const tokens: string[] = [];

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-comms-paging-"));
  mutableConfig.dataDir = path.join(root, "data");
  setDataRoomQueueAutoKickForTests(false);
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mcp`;
});

after(async () => {
  for (const token of tokens) revokeMcpToken(token);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: `acme-${randomUUID()}`, ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Fiona",
    slug: "fiona",
    role: "CFO",
    soulBody: "",
  });
});

function token(forEmployee = employee, companyId = company.id): string {
  const issued = issueMcpToken(forEmployee.id, companyId, { authority: "employee" });
  tokens.push(issued);
  return issued;
}

type Page = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
};

async function call(name: string, args: Record<string, unknown>, bearer = token()) {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Page };
}

async function readEveryPage(
  tool: string,
  rowsKey: string,
  args: Record<string, unknown>,
  bearer = token(),
) {
  const ids: string[] = [];
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await call(tool, { ...args, ...(cursor ? { cursor } : {}) }, bearer);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(...(page.body[rowsKey] as Array<{ id: string }>).map((row) => row.id));
    if (!page.body.hasMore) return { ids, pages };
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

const BASE = Date.UTC(2025, 5, 1);

// ───────────────────────────── Data rooms ─────────────────────────────

async function grantDataRooms(forEmployee = employee, companyId = company.id) {
  await insert(EmployeeDataRoomGrant, {
    companyId,
    employeeId: forEmployee.id,
    accessLevel: "read",
  });
}

async function room(name: string, companyId = company.id): Promise<DataRoom> {
  return createDataRoom({ companyId, name, purpose: "fundraising", actor: { kind: "system" } });
}

async function guest(r: DataRoom, name: string, organization: string): Promise<DataRoomGuest> {
  return insert(DataRoomGuest, {
    companyId: r.companyId,
    roomId: r.id,
    name,
    email: `${name.toLowerCase()}@${organization.toLowerCase()}.vc`,
    organization,
    tokenHash: randomUUID(),
    tokenEncrypted: "sealed",
  });
}

async function questions(
  r: DataRoom,
  guests: DataRoomGuest[],
  count: number,
  extra: (index: number) => Partial<DataRoomQuestion> = () => ({}),
): Promise<DataRoomQuestion[]> {
  const repo = AppDataSource.getRepository(DataRoomQuestion);
  const rows = Array.from({ length: count }, (_, i) =>
    repo.create({
      companyId: r.companyId,
      roomId: r.id,
      guestId: guests[i % guests.length].id,
      documentId: null,
      body: `Question ${i}`,
      status: "open",
      createdAt: new Date(BASE + Math.floor(i / 5) * 60_000),
      ...extra(i),
    }),
  );
  const saved: DataRoomQuestion[] = [];
  for (let start = 0; start < rows.length; start += 200) {
    saved.push(...(await repo.save(rows.slice(start, start + 200))));
  }
  return saved;
}

type QuestionRow = {
  id: string;
  question: string;
  status: string;
  askedAt: string;
  guest: { name: string; organization: string } | null;
  answer: string | null;
};

describe("list_data_room_questions", () => {
  test("pages past the old 200, questions sharing an instant included, each naming its guest", async () => {
    await grantDataRooms();
    const seriesA = await room("Series A");
    const guests = [
      await guest(seriesA, "Ada", "Acme"),
      await guest(seriesA, "Bo", "Basis"),
      await guest(seriesA, "Cy", "Crest"),
    ];
    await questions(seriesA, guests, 230);
    const all = await readEveryPage("list_data_room_questions", "questions", { roomId: seriesA.id });
    assert.equal(all.ids.length, 230);
    assert.equal(new Set(all.ids).size, 230);
    assert.ok(all.pages.every((page) => page.total === 230));
    assert.ok(
      all.pages.every((page) => /untrusted data/.test(String(page.note))),
      "every page says a guest's words are data",
    );
    const rows = all.pages.flatMap((page) => page.questions as QuestionRow[]);
    const asked = rows.map((row) => Date.parse(row.askedAt));
    assert.deepEqual(asked, [...asked].sort((a, b) => b - a), "newest first");
    assert.ok(rows.every((row) => row.guest && guests.some((g) => g.name === row.guest!.name)));
    assert.equal((all.pages[0].questions as unknown[]).length, 50, "50 by default");
  });

  test("filters by status, and a question answered between pages never makes a page skip another", async () => {
    await grantDataRooms();
    const seriesA = await room("Series A");
    const guests = [await guest(seriesA, "Ada", "Acme")];
    const all = await questions(seriesA, guests, 90, (i) =>
      i % 3 === 0 ? { status: "answered", answer: "See the model.", answeredAt: new Date() } : {},
    );
    const answered = await call("list_data_room_questions", { roomId: seriesA.id, status: "answered" });
    assert.equal(answered.body.total, 30);
    assert.ok((answered.body.questions as QuestionRow[]).every((row) => row.answer === "See the model."));
    const open = all.filter((_, i) => i % 3 !== 0);
    const bearer = token();
    const first = await call(
      "list_data_room_questions",
      { roomId: seriesA.id, status: "open", limit: 20 },
      bearer,
    );
    assert.equal(first.body.total, 60);
    const seen = (first.body.questions as QuestionRow[]).map((row) => row.id);
    // Answering takes questions out of the open filter: five already read, and
    // five not yet read — those leave the list, and nothing else may move.
    const unread = open.filter((question) => !seen.includes(question.id));
    const answeredNow = [...seen.slice(0, 5), ...unread.slice(0, 5).map((question) => question.id)];
    for (const id of answeredNow) {
      await AppDataSource.getRepository(DataRoomQuestion).update({ id }, { status: "answered" });
    }
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await call(
        "list_data_room_questions",
        { roomId: seriesA.id, status: "open", limit: 20, cursor },
        bearer,
      );
      assert.equal(page.status, 200, page.body.error);
      seen.push(...(page.body.questions as QuestionRow[]).map((row) => row.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length, "none twice");
    const unreadAnswered = new Set(unread.slice(0, 5).map((question) => question.id));
    assert.deepEqual(
      new Set(seen),
      new Set(open.map((question) => question.id).filter((id) => !unreadAnswered.has(id))),
      "every question still open, once",
    );
  });

  test("a cursor is bound to its room and list; another company's room and no Grant are refused", async () => {
    const seriesA = await room("Series A");
    const audit = await room("Audit");
    const guests = [await guest(seriesA, "Ada", "Acme")];
    await questions(seriesA, guests, 30);
    await questions(audit, [await guest(audit, "Ida", "Ivy")], 30);
    const refused = await call("list_data_room_questions", { roomId: seriesA.id });
    assert.equal(refused.status, 403, "no Grant, no questions");
    assert.match(String(refused.body.error), /Data rooms → AI access/);

    await grantDataRooms();
    const first = await call("list_data_room_questions", { roomId: seriesA.id, limit: 10 });
    const otherRoom = await call("list_data_room_questions", {
      roomId: audit.id,
      cursor: first.body.nextCursor,
    });
    assert.equal(otherRoom.status, 400);
    assert.equal(otherRoom.body.error, CURSOR_OTHER_FILTERS);
    const otherStatus = await call("list_data_room_questions", {
      roomId: seriesA.id,
      status: "open",
      cursor: first.body.nextCursor,
    });
    assert.equal(otherStatus.body.error, CURSOR_OTHER_FILTERS);
    const envelopes = await insertEnvelopes(60);
    assert.equal(envelopes.length, 60);
    await grantSigning();
    const envelopePage = await call("list_signature_envelopes", { limit: 10 });
    const otherList = await call("list_data_room_questions", {
      roomId: seriesA.id,
      cursor: envelopePage.body.nextCursor,
    });
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);

    const globex = await insert(Company, {
      name: "Globex",
      slug: `globex-${randomUUID()}`,
      ownerId: "owner",
    });
    const theirs = await room("Theirs", globex.id);
    await questions(theirs, [await guest(theirs, "Mo", "Moxie")], 3);
    assert.equal(
      (await call("list_data_room_questions", { roomId: theirs.id })).status,
      404,
      "another company's room is not there",
    );
  });

  test("reading any page taints the turn, a large limit is cut, and long questions end a page early", async () => {
    assert.equal(isTaintSource("list_data_room_questions"), true);
    await grantDataRooms();
    const seriesA = await room("Series A");
    const guests = [await guest(seriesA, "Ada", "Acme")];
    await questions(seriesA, guests, 60, (i) => ({ body: `${i} `.padEnd(5_000, "q") }));
    const first = await call("list_data_room_questions", { roomId: seriesA.id, limit: 1_000 });
    assert.equal(first.status, 200, "a larger limit is cut, not refused");
    const shown = first.body.questions as QuestionRow[];
    assert.ok(shown.length < 60, "ended before the tool result would overflow");
    assert.ok(JSON.stringify(shown, null, 2).length <= TOOL_PAGE_BUDGET_CHARS + 6_000);
    assert.equal(first.body.hasMore, true);

    const fresh = token();
    assert.equal(isTokenTainted(fresh), false);
    const later = await call(
      "list_data_room_questions",
      { roomId: seriesA.id, limit: 1_000, cursor: first.body.nextCursor },
      fresh,
    );
    assert.equal(later.status, 200);
    assert.equal(isTokenTainted(fresh), true, "a later page is a stranger's words too");
    const all = await readEveryPage("list_data_room_questions", "questions", {
      roomId: seriesA.id,
      limit: 1_000,
    });
    assert.equal(new Set(all.ids).size, 60);
    assert.equal((await call("list_data_room_questions", { roomId: seriesA.id, limit: 0 })).status, 400);
  });
});

// ─────────────────────────── Signature envelopes ───────────────────────────

async function grantSigning(forEmployee = employee, companyId = company.id) {
  await insert(EmployeeSigningGrant, { companyId, employeeId: forEmployee.id, accessLevel: "read" });
}

async function insertEnvelopes(
  count: number,
  extra: (index: number) => Partial<SignatureEnvelope> = () => ({}),
  companyId = company.id,
): Promise<SignatureEnvelope[]> {
  const repo = AppDataSource.getRepository(SignatureEnvelope);
  const rows = Array.from({ length: count }, (_, i) =>
    repo.create({
      companyId,
      title: `Agreement ${i}`,
      originalFilename: `agreement-${i}.pdf`,
      originalStorageKey: `${randomUUID()}.pdf`,
      status: "sent",
      createdAt: new Date(BASE + Math.floor(i / 5) * 60_000),
      updatedAt: new Date(BASE + Math.floor(i / 5) * 60_000),
      ...extra(i),
    }),
  );
  const saved: SignatureEnvelope[] = [];
  for (let start = 0; start < rows.length; start += 200) {
    saved.push(...(await repo.save(rows.slice(start, start + 200))));
  }
  return saved;
}

async function signers(envelope: SignatureEnvelope, total: number, completed: number) {
  for (let i = 0; i < total; i++) {
    await insert(SignatureRecipient, {
      companyId: envelope.companyId,
      envelopeId: envelope.id,
      role: "signer",
      name: `Signer ${i}`,
      email: `signer-${i}@example.test`,
      routingOrder: i,
      status: i < completed ? "completed" : "sent",
      tokenHash: randomUUID(),
    });
  }
  // A copy recipient is not counted as a signer.
  await insert(SignatureRecipient, {
    companyId: envelope.companyId,
    envelopeId: envelope.id,
    role: "copy",
    name: "Copy",
    email: "copy@example.test",
    routingOrder: 9,
    status: "waiting",
    tokenHash: null,
  });
}

type EnvelopeRow = Record<string, unknown> & {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  recipientCount: number;
  completedRecipientCount: number;
};

describe("list_signature_envelopes", () => {
  test("pages past the old cap of 100, newest first by creation, counting each page's signers", async () => {
    await grantSigning();
    const envelopes = await insertEnvelopes(130);
    await signers(envelopes[129], 3, 2);
    await signers(envelopes[0], 1, 0);
    const all = await readEveryPage("list_signature_envelopes", "envelopes", { limit: 30 });
    assert.equal(all.ids.length, 130);
    assert.equal(new Set(all.ids).size, 130);
    assert.ok(all.pages.every((page) => page.total === 130 && page.accessLevel === "read"));
    const rows = all.pages.flatMap((page) => page.envelopes as EnvelopeRow[]);
    const created = rows.map((row) => Date.parse(row.createdAt));
    assert.deepEqual(created, [...created].sort((a, b) => b - a), "newest first by creation");
    const newest = rows.find((row) => row.id === envelopes[129].id)!;
    assert.deepEqual([newest.recipientCount, newest.completedRecipientCount], [3, 2]);
    const oldest = rows.find((row) => row.id === envelopes[0].id)!;
    assert.deepEqual([oldest.recipientCount, oldest.completedRecipientCount], [1, 0]);
    assert.ok(rows.filter((row) => row.recipientCount === 0).length === 128);
  });

  test("filters by status, customer and words in the title or filename, alone and together", async () => {
    await grantSigning();
    const customerId = randomUUID();
    await insertEnvelopes(40, (i) => ({
      status: i % 4 === 0 ? "completed" : "sent",
      customerId: i % 2 === 0 ? customerId : null,
      title: i % 5 === 0 ? `Master Services Agreement ${i}` : `Order form ${i}`,
      originalFilename: i === 7 ? "Acme-NDA-final.pdf" : `doc-${i}.pdf`,
    }));
    assert.equal((await call("list_signature_envelopes", { status: "completed" })).body.total, 10);
    assert.equal((await call("list_signature_envelopes", { customerId })).body.total, 20);
    const words = await call("list_signature_envelopes", { query: "services MASTER" });
    assert.equal(words.body.total, 8, "every word, in any order and any case");
    const byFilename = await call("list_signature_envelopes", { query: "nda" });
    assert.deepEqual(
      (byFilename.body.envelopes as EnvelopeRow[]).map((row) => row.title),
      ["Order form 7"],
    );
    const combined = await call("list_signature_envelopes", {
      status: "completed",
      customerId,
      query: "master",
    });
    // i % 4 === 0 (completed, and so even: the customer's) and i % 5 === 0.
    assert.equal(combined.body.total, 2);
    assert.equal((await call("list_signature_envelopes", { query: "100%" })).body.total, 0);
  });

  test("an envelope a signer acts on between pages is neither skipped nor repeated", async () => {
    await grantSigning();
    const envelopes = await insertEnvelopes(75);
    const bearer = token();
    const first = await call("list_signature_envelopes", { limit: 20 }, bearer);
    const seen = (first.body.envelopes as EnvelopeRow[]).map((row) => row.id);
    // A signer completes an envelope not yet read: it changes, and moves to
    // the top of Signatures — but not out of reach of this read.
    const unread = envelopes.filter((envelope) => !seen.includes(envelope.id));
    await AppDataSource.getRepository(SignatureEnvelope).update(
      { id: unread[10].id },
      { status: "completed", updatedAt: new Date(BASE + 86_400_000) },
    );
    let cursor = first.body.nextCursor!;
    for (;;) {
      const page = await call("list_signature_envelopes", { limit: 20, cursor }, bearer);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...(page.body.envelopes as EnvelopeRow[]).map((row) => row.id));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(seen.length, 75);
    assert.equal(new Set(seen).size, 75);
  });

  test("rows are redacted as get_signature_envelope redacts, and never carry the PDF's text", async () => {
    await grantSigning();
    const [envelope] = await insertEnvelopes(1, () => ({
      documentText: "CONFIDENTIAL CLAUSE ".repeat(5_000),
      completedStorageKey: "completed-secret.pdf",
    }));
    const list = await call("list_signature_envelopes", {});
    const [row] = list.body.envelopes as EnvelopeRow[];
    for (const hidden of ["originalStorageKey", "completedStorageKey", "documentText"]) {
      assert.equal(hidden in row, false, hidden);
    }
    assert.equal(JSON.stringify(list.body).includes("CONFIDENTIAL CLAUSE"), false);
    assert.equal(JSON.stringify(list.body).includes("completed-secret"), false);
    const detail = await call("get_signature_envelope", { envelopeId: envelope.id });
    assert.equal(detail.status, 200, detail.body.error);
    const full = detail.body.envelope as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(row).filter((key) => !["recipientCount", "completedRecipientCount"].includes(key)).sort(),
      Object.keys(full).sort(),
      "the listing shows what the full read shows, and nothing more",
    );
  });

  test("never another company's envelopes; no Grant, no list; a large limit is cut by the budget", async () => {
    const refused = await call("list_signature_envelopes", {});
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /No grant/);
    await grantSigning();
    await insertEnvelopes(130, (i) => ({ message: `Please sign agreement ${i}. `.repeat(10) }));
    const globex = await insert(Company, {
      name: "Globex",
      slug: `globex-${randomUUID()}`,
      ownerId: "owner",
    });
    const theirEmployee = await insert(AIEmployee, {
      companyId: globex.id,
      name: "Gil",
      slug: "gil",
      role: "Legal",
      soulBody: "",
    });
    await insertEnvelopes(12, () => ({ title: "Globex agreement" }), globex.id);
    await grantSigning(theirEmployee, globex.id);

    const big = await call("list_signature_envelopes", { limit: 1_000 });
    assert.equal(big.status, 200, "a larger limit is cut, not refused");
    const shown = big.body.envelopes as EnvelopeRow[];
    assert.ok(shown.length > 0 && shown.length <= 100);
    assert.ok(JSON.stringify(shown, null, 2).length <= TOOL_PAGE_BUDGET_CHARS + 6_000);
    assert.equal(big.body.hasMore, true);
    const all = await readEveryPage("list_signature_envelopes", "envelopes", { limit: 1_000 });
    assert.equal(new Set(all.ids).size, 130);
    const rows = all.pages.flatMap((page) => page.envelopes as EnvelopeRow[]);
    assert.equal(rows.some((row) => row.title === "Globex agreement"), false);

    const theirs = await call("list_signature_envelopes", {}, token(theirEmployee, globex.id));
    assert.equal(theirs.body.total, 12);
    const first = await call("list_signature_envelopes", { limit: 5 });
    const crossCompany = await call(
      "list_signature_envelopes",
      { limit: 5, cursor: first.body.nextCursor },
      token(theirEmployee, globex.id),
    );
    assert.equal(crossCompany.status, 400);
    assert.equal(crossCompany.body.error, CURSOR_OTHER_FILTERS);
    assert.equal((await call("list_signature_envelopes", { limit: 0 })).status, 400);
  });
});
