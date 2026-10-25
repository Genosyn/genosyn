import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { setDataRoomQueueAutoKickForTests } from "../services/dataRooms/queue.js";
import { dataRoomPrivateCompanyDir } from "../services/paths.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { dataRoomsRouter } from "./dataRooms.js";
import { publicDataRoomSecurityHeaders, publicDataRoomsRouter } from "./publicDataRooms.js";

/**
 * Data rooms over HTTP: the company's side is owners' and admins' alone, and a
 * guest's link opens exactly their room, their folders and their questions —
 * with an unknown link indistinguishable from a malformed one.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let member: User;
let company: Company;

before(async () => {
  await initTestDb();
  setDataRoomQueueAutoKickForTests(false);
  const app = express();
  app.use("/api/room", publicDataRoomSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/room", publicDataRoomsRouter);
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", dataRoomsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Northwind",
    slug: `northwind-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  actingUserId = owner.id;
});

afterEach(() => {
  if (company) fs.rmSync(dataRoomPrivateCompanyDir(company.id), { recursive: true, force: true });
});

async function call<T = Record<string, unknown>>(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed as T, text, headers: response.headers };
}

async function upload(roomId: string, filename: string, text: string, folderId?: string) {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/markdown" }), filename);
  if (folderId) form.append("folderId", folderId);
  const response = await fetch(
    `${baseUrl}/api/companies/${company.id}/data-rooms/${roomId}/documents`,
    {
      method: "POST",
      body: form,
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

type Detail = {
  room: { id: string };
  folders: Array<{ id: string; name: string }>;
  documents: Array<{ id: string }>;
};

describe("the company's side", () => {
  test("is owners' and admins' alone, reads included", async () => {
    actingUserId = member.id;
    assert.equal((await call("GET", `/api/companies/${company.id}/data-rooms`)).status, 403);
    assert.equal(
      (
        await call("POST", `/api/companies/${company.id}/data-rooms`, {
          name: "Raise",
          purpose: "fundraising",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("GET", `/api/companies/${company.id}/data-rooms/ai-access`)).status,
      403,
    );
    actingUserId = owner.id;
    assert.equal((await call("GET", `/api/companies/${company.id}/data-rooms`)).status, 200);
  });

  test("an owner opens a room, files a document and invites a guest, whose link never leaks a token hash", async () => {
    const created = await call<Detail>("POST", `/api/companies/${company.id}/data-rooms`, {
      name: "Series A",
      purpose: "fundraising",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.folders.length, 6);
    const uploaded = await upload(
      created.body.room.id,
      "deck.md",
      "# Deck\nWe sell robots to warehouses.",
    );
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.textStatus, "extracted");
    assert.equal("storageKey" in uploaded.body, false);

    const refused = await upload(created.body.room.id, "page.html", "<script>alert(1)</script>");
    assert.equal(
      refused.status,
      400,
      "a room never stores a page that could run on the App's origin",
    );

    const invited = await call<{ guest: Record<string, unknown>; link: string }>(
      "POST",
      `/api/companies/${company.id}/data-rooms/${created.body.room.id}/guests`,
      { name: "Ada", email: "Ada@Acme.vc", sendInvitation: false },
    );
    assert.equal(invited.status, 201);
    assert.match(invited.body.link, /\/room\/[A-Za-z0-9_-]{43}$/);
    assert.equal(invited.body.guest.email, "ada@acme.vc");
    assert.equal("tokenHash" in invited.body.guest, false);
    assert.equal("tokenEncrypted" in invited.body.guest, false);

    const copied = await call<{ link: string }>(
      "GET",
      `/api/companies/${company.id}/data-rooms/${created.body.room.id}/guests/${invited.body.guest.id}/link`,
    );
    assert.equal(copied.body.link, invited.body.link);
  });
});

describe("a guest's link", () => {
  async function seed(folderLimited: boolean) {
    const created = await call<Detail>("POST", `/api/companies/${company.id}/data-rooms`, {
      name: "Series A",
      purpose: "fundraising",
    });
    const roomId = created.body.room.id;
    const financials = created.body.folders.find((folder) => folder.name === "Financials")!;
    const team = created.body.folders.find((folder) => folder.name === "Team")!;
    const shared = await upload(roomId, "model.md", "ARR was 2.4M in 2025.", financials.id);
    const hidden = await upload(roomId, "salaries.md", "Salaries are private.", team.id);
    const invited = await call<{ guest: { id: string }; link: string }>(
      "POST",
      `/api/companies/${company.id}/data-rooms/${roomId}/guests`,
      {
        name: "Ada",
        email: "ada@acme.vc",
        sendInvitation: false,
        folderIds: folderLimited ? [financials.id] : [],
      },
    );
    const token = invited.body.link.split("/room/")[1];
    actingUserId = null;
    return {
      roomId,
      token,
      guestId: invited.body.guest.id,
      shared: shared.body.id,
      hidden: hidden.body.id,
    };
  }

  test("opens only the guest's folders, uncached, and refuses downloads in a view-only room", async () => {
    const { token, shared, hidden } = await seed(true);
    const view = await call<{ documents: Array<{ id: string }>; folders: Array<{ name: string }> }>(
      "GET",
      `/api/room/${token}`,
    );
    assert.equal(view.status, 200);
    assert.equal(view.headers.get("cache-control"), "private, no-store");
    assert.equal(view.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.deepEqual(
      view.body.documents.map((document) => document.id),
      [shared],
    );
    assert.deepEqual(
      view.body.folders.map((folder) => folder.name),
      ["Financials"],
    );

    const file = await call("GET", `/api/room/${token}/documents/${shared}/file`);
    assert.equal(file.status, 200);
    assert.equal(file.text, "ARR was 2.4M in 2025.");
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await call("GET", `/api/room/${token}/documents/${hidden}/file`)).status, 404);
    assert.equal(
      (await call("GET", `/api/room/${token}/documents/${shared}/file?download=1`)).status,
      409,
    );
  });

  test("an unknown or malformed link answers the same 404, and a revoked one says so", async () => {
    const { roomId, token, guestId } = await seed(false);
    const unknown = await call("GET", `/api/room/${"a".repeat(43)}`);
    const malformed = await call("GET", "/api/room/not-a-token");
    assert.equal(unknown.status, 404);
    assert.equal(malformed.status, 404);
    assert.deepEqual(unknown.body, malformed.body);
    assert.equal(unknown.headers.get("cache-control"), "private, no-store");

    actingUserId = owner.id;
    await call(
      "POST",
      `/api/companies/${company.id}/data-rooms/${roomId}/guests/${guestId}/revoke`,
      {},
    );
    actingUserId = null;
    const revoked = await call<{ blocked: string; companyName: string }>(
      "GET",
      `/api/room/${token}`,
    );
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.blocked, "revoked");
    assert.equal(revoked.body.companyName, "Northwind");
  });

  test("asks a question that only that guest sees, and times reading", async () => {
    const { roomId, token, shared } = await seed(false);
    const asked = await call<{ id: string; status: string }>(
      "POST",
      `/api/room/${token}/questions`,
      {
        question: "What was ARR in 2025?",
        documentId: shared,
      },
    );
    assert.equal(asked.status, 201);
    assert.equal(asked.body.status, "open");
    const view = await call<{ questions: Array<{ id: string; documentId: string | null }> }>(
      "GET",
      `/api/room/${token}`,
    );
    assert.deepEqual(
      view.body.questions.map((question) => question.id),
      [asked.body.id],
    );
    assert.equal(view.body.questions[0].documentId, shared);

    const opened = await call<{ viewId: string }>("POST", `/api/room/${token}/views`, {
      documentId: shared,
    });
    assert.equal(opened.status, 201);
    assert.equal(
      (
        await call("POST", `/api/room/${token}/views/${opened.body.viewId}/heartbeat`, {
          seconds: 30,
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await call("POST", `/api/room/${token}/views/${opened.body.viewId}/heartbeat`, {
          seconds: 600,
        })
      ).status,
      400,
      "a heartbeat claims at most two minutes",
    );

    actingUserId = owner.id;
    const questions = await call<{ questions: Array<{ id: string; guest: { email: string } }> }>(
      "GET",
      `/api/companies/${company.id}/data-rooms/${roomId}/questions`,
    );
    assert.equal(questions.body.questions[0].guest.email, "ada@acme.vc");
    const activity = await call<{ totals: { totalSeconds: number } }>(
      "GET",
      `/api/companies/${company.id}/data-rooms/${roomId}/activity`,
    );
    assert.equal(activity.body.totals.totalSeconds, 30);
  });
});
