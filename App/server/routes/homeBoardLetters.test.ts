import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { deliverBoardLetter } from "../services/boardLetterNotice.js";
import type { HomeData } from "../services/home.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { boardLettersRouter } from "./boardLetters.js";
import { homeRouter } from "./home.js";

/**
 * Home over HTTP, with real authentication and membership checks: owners and
 * admins find the newest letter to the board they have not read, and a
 * Member's Home carries no part of one, whatever bell rows they still hold.
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
  app.use("/api/companies/:cid", homeRouter);
  app.use("/api/companies/:cid", boardLettersRouter);
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

beforeEach(async () => {
  await resetTestDb();
  const user = (email: string) =>
    insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  owner = await user("owner@sunwise.test");
  admin = await user("admin@sunwise.test");
  member = await user("member@sunwise.test");
  formerAdmin = await user("former-admin@sunwise.test");
  company = await insert(Company, { name: "Sunwise", slug: "home-sunwise", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: company.id, userId: formerAdmin.id, role: "admin" });
  await deliveredLetter(1, "2026-08", "August held steady.");
  await deliveredLetter(2, "2026-09", "September grew 41%.");
  // Told while on the board, then made a Member: the bell rows stay theirs.
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: formerAdmin.id },
    { role: "member" },
  );
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

async function home(userId: string): Promise<{ text: string; data: HomeData }> {
  actingUserId = userId;
  const response = await call("GET", "/home");
  assert.equal(response.status, 200);
  return { text: response.text, data: JSON.parse(response.text) as HomeData };
}

describe("the letter to the board on Home", () => {
  test("reaches owners and admins: the newest unread letter, and how many wait", async () => {
    for (const userId of [owner.id, admin.id]) {
      const { data } = await home(userId);
      assert.equal(data.boardLetter?.number, 2);
      assert.equal(data.boardLetter?.monthLabel, "September 2026");
      assert.equal(data.boardLetter?.summary, "September grew 41%.");
      assert.equal(data.boardLetter?.auditStatus, "unverified");
      assert.equal(data.unreadBoardLetterCount, 2);
    }
  });

  test("never reaches a Member, not even one who still holds the bell rows", async () => {
    for (const userId of [member.id, formerAdmin.id]) {
      const { text, data } = await home(userId);
      assert.equal(data.boardLetter, null);
      assert.equal(data.unreadBoardLetterCount, 0);
      assert.equal(data.unreadNotificationCount, 0);
      // Nothing of a letter anywhere in the response: no title, no summary.
      assert.doesNotMatch(text, /to the board|held steady|grew 41|board_letter|tldrs\/letters/);
      assert.equal((await call("POST", "/board-letters/2/read", {})).status, 403);
    }
  });

  test("leaves the reader's Home once read, and the older letter comes forward", async () => {
    actingUserId = owner.id;
    assert.equal((await call("POST", "/board-letters/2/read", {})).status, 200);
    let mine = await home(owner.id);
    assert.equal(mine.data.boardLetter?.number, 1);
    assert.equal(mine.data.unreadBoardLetterCount, 1);
    // The admin has not read it, so it is still theirs to read.
    assert.equal((await home(admin.id)).data.boardLetter?.number, 2);

    actingUserId = owner.id;
    assert.equal((await call("POST", "/board-letters/1/read", {})).status, 200);
    mine = await home(owner.id);
    assert.equal(mine.data.boardLetter, null);
    assert.equal(mine.data.unreadBoardLetterCount, 0);
  });
});
