import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { deliverBoardLetter } from "../services/boardLetterNotice.js";
import type { NotificationDTO } from "../services/notifications.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { notificationsRouter } from "./notifications.js";

/**
 * The bell over HTTP, with real authentication and membership checks. Each
 * owner and admin is sent a bell row for every letter to the board, and an
 * admin later made a Member keeps theirs. Their bell must carry no part of a
 * letter, and must not change a letter's read state either.
 */

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;
let owner: User;
let admin: User;
let member: User;
let formerAdmin: User;

const originalLog = console.log;
const LETTER_TEXT = /to the board|held steady|grew 41|board_letter|tldrs\/letters/;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
          secondFactorAt: Date.now(),
        }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", notificationsRouter);
  app.use(errorHandler);
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

async function deliveredLetter(number: number, month: string, summary: string) {
  const periodStart = new Date(`${month}-01T00:00:00Z`);
  const letter = await insert(BoardLetter, {
    companyId: company.id,
    number,
    month,
    periodStart,
    periodEnd: new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1)),
    status: "ready",
    startedAt: periodStart,
    writtenAt: periodStart,
    figuresJson: JSON.stringify({ figures: [], goals: [] }),
    writerName: "Ada",
    auditStatus: "unverified",
    auditorName: "Otto",
    summary,
    body: `${summary} The rest of the letter.`,
  });
  console.log = () => undefined;
  try {
    assert.equal(await deliverBoardLetter(letter.id), true);
  } finally {
    console.log = originalLog;
  }
  return letter;
}

async function setRole(userId: string, role: Role) {
  await AppDataSource.getRepository(Membership).update({ companyId: company.id, userId }, { role });
}

beforeEach(async () => {
  await resetTestDb();
  const user = (email: string) =>
    insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  owner = await user("owner@bell.test");
  admin = await user("admin@bell.test");
  member = await user("member@bell.test");
  formerAdmin = await user("former-admin@bell.test");
  company = await insert(Company, { name: "Sunwise", slug: "bell-sunwise", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: company.id, userId: formerAdmin.id, role: "admin" });
  await deliveredLetter(1, "2026-08", "August held steady.");
  await deliveredLetter(2, "2026-09", "September grew 41%.");
  // Everyone has something else in the bell, which must stay theirs.
  for (const recipient of [owner, admin, member, formerAdmin]) {
    await insert(Notification, {
      companyId: company.id,
      userId: recipient.id,
      kind: "mention",
      title: "Sam mentioned you in #general",
      body: "Can you look at the deck?",
      link: "/c/bell-sunwise/workspace",
      actorKind: "system",
    });
  }
  // Told while on the board, then made a Member: the letter rows stay theirs.
  await setRole(formerAdmin.id, "member");
  actingUserId = owner.id;
});

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function bell(userId: string, query = "?limit=100") {
  actingUserId = userId;
  const list = await call("GET", `/notifications${query}`);
  assert.equal(list.status, 200);
  const count = await call("GET", "/notifications/unread-count");
  assert.equal(count.status, 200);
  return {
    text: list.text + count.text,
    rows: (JSON.parse(list.text) as { notifications: NotificationDTO[] }).notifications,
    count: (JSON.parse(count.text) as { count: number }).count,
  };
}

/** This person's letter rows straight from the table, by title: [title, unread]. */
async function letterRows(userId: string): Promise<Array<[string, boolean]>> {
  const rows = await AppDataSource.getRepository(Notification).find({
    where: { companyId: company.id, userId, kind: "board_letter_ready" },
  });
  return rows
    .map((row): [string, boolean] => [row.title, row.readAt === null])
    .sort(([a], [b]) => a.localeCompare(b));
}

describe("letters to the board in the bell", () => {
  test("reach owners and admins, with each letter's title and summary", async () => {
    for (const userId of [owner.id, admin.id]) {
      const { rows, count } = await bell(userId);
      assert.deepEqual(
        rows
          .filter((row) => row.kind === "board_letter_ready")
          .map((row) => [row.title, row.body])
          .sort(([a], [b]) => a.localeCompare(b)),
        [
          ["Letter No. 1 to the board · August 2026", "August held steady."],
          ["Letter No. 2 to the board · September 2026", "September grew 41%."],
        ],
      );
      assert.equal(rows.length, 3);
      assert.equal(count, 3);
    }
  });

  test("never reach a Member, not even one who still holds the rows", async () => {
    for (const userId of [member.id, formerAdmin.id]) {
      for (const query of ["", "?limit=100", "?before=2999-01-01T00:00:00.000Z"]) {
        const { text, rows, count } = await bell(userId, query);
        // Nothing of a letter anywhere: no title, no summary, no kind, no link.
        assert.doesNotMatch(text, LETTER_TEXT);
        assert.deepEqual(
          rows.map((row) => row.kind),
          ["mention"],
        );
        assert.equal(count, 1);
      }
    }
    // Left out, not lost: the former admin still holds both, unread.
    assert.deepEqual(await letterRows(formerAdmin.id), [
      ["Letter No. 1 to the board · August 2026", true],
      ["Letter No. 2 to the board · September 2026", true],
    ]);
  });
});

describe("a Member's bell leaves the letter rows alone", () => {
  test("marking and clearing skip them, so an admin again finds them as they were", async () => {
    // Letter 1 was read while still on the board.
    await AppDataSource.getRepository(Notification).update(
      { userId: formerAdmin.id, title: "Letter No. 1 to the board · August 2026" },
      { readAt: new Date() },
    );
    const kept = await AppDataSource.getRepository(Notification).findOneByOrFail({
      userId: formerAdmin.id,
      title: "Letter No. 2 to the board · September 2026",
    });

    actingUserId = formerAdmin.id;
    // The id a bell panel opened before the change still holds.
    const markOne = await call("POST", "/notifications/mark-read", { notificationId: kept.id });
    assert.equal(markOne.status, 200);
    assert.equal((await call("POST", "/notifications/mark-all-read")).status, 200);
    const cleared = await call("POST", "/notifications/clear-read");
    assert.equal(cleared.status, 200);
    // Only the mention was theirs to read and clear.
    assert.deepEqual(JSON.parse(cleared.text), { cleared: 1 });
    assert.equal((await bell(formerAdmin.id)).rows.length, 0);
    assert.deepEqual(await letterRows(formerAdmin.id), [
      ["Letter No. 1 to the board · August 2026", false],
      ["Letter No. 2 to the board · September 2026", true],
    ]);

    await setRole(formerAdmin.id, "admin");
    const { rows, count } = await bell(formerAdmin.id);
    assert.deepEqual(
      rows
        .map((row): [string, boolean] => [row.title, row.readAt === null])
        .sort(([a], [b]) => a.localeCompare(b)),
      [
        ["Letter No. 1 to the board · August 2026", false],
        ["Letter No. 2 to the board · September 2026", true],
      ],
    );
    assert.equal(count, 1);
  });

  test("owners and admins still read and clear theirs from the bell", async () => {
    const letter = await AppDataSource.getRepository(Notification).findOneByOrFail({
      userId: admin.id,
      kind: "board_letter_ready",
      title: "Letter No. 2 to the board · September 2026",
    });
    actingUserId = admin.id;
    assert.equal(
      (await call("POST", "/notifications/mark-read", { notificationId: letter.id })).status,
      200,
    );
    assert.deepEqual(await letterRows(admin.id), [
      ["Letter No. 1 to the board · August 2026", true],
      ["Letter No. 2 to the board · September 2026", false],
    ]);

    actingUserId = owner.id;
    assert.equal((await call("POST", "/notifications/mark-all-read")).status, 200);
    assert.equal((await bell(owner.id)).count, 0);
    assert.deepEqual(JSON.parse((await call("POST", "/notifications/clear-read")).text), {
      cleared: 3,
    });
    assert.deepEqual(await letterRows(owner.id), []);
  });
});
