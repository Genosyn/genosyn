import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { deliverBoardLetter } from "./boardLetterNotice.js";
import { listUnreadBoardLetters, markBoardLetterRead } from "./boardLetterReads.js";
import { BoardLetterNotFoundError } from "./boardLetters.js";
import { markAllRead, markRead } from "./notifications.js";

/**
 * A letter's read state is each owner's and admin's own bell notification for
 * it. These pin what that means: reading is one person's, the bell and Home
 * never disagree, and Home shows the letters that were sent to someone.
 */

before(initTestDb);
after(closeTestDb);
beforeEach(resetTestDb);

const originalLog = console.log;

let company: Company;
let owner: User;
let admin: User;

async function person(email: string, role: Role, companyId = company.id): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x" });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

/** A finished letter, told to the board the way the scheduler tells it. */
async function deliveredLetter(
  number: number,
  month: string,
  companyId = company.id,
): Promise<BoardLetter> {
  const periodStart = new Date(`${month}-01T00:00:00Z`);
  const letter = await insert(BoardLetter, {
    companyId,
    number,
    month,
    periodStart,
    periodEnd: new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1)),
    status: "ready",
    startedAt: periodStart,
    writtenAt: periodStart,
    figuresJson: JSON.stringify({ figures: [], goals: [] }),
    writerName: "Ada",
    auditStatus: "clean",
    auditorName: "Otto",
    summary: `Letter ${number} in a sentence.`,
    body: `Letter ${number}, in full.`,
  });
  // The email goes to the console when no transport is set up.
  console.log = () => undefined;
  try {
    assert.equal(await deliverBoardLetter(letter.id), true);
  } finally {
    console.log = originalLog;
  }
  return letter;
}

async function unread(user: User, role: Role = "owner") {
  const result = await listUnreadBoardLetters({ companyId: company.id, userId: user.id, role });
  return { number: result.letter?.number ?? null, count: result.unreadCount };
}

async function bell(user: User, letter: BoardLetter): Promise<Notification> {
  return AppDataSource.getRepository(Notification).findOneByOrFail({
    userId: user.id,
    entityKind: "board_letter",
    entityId: letter.id,
  });
}

beforeEach(async () => {
  owner = await insert(User, { email: "owner@sunwise.test", name: "Owner", passwordHash: "x" });
  company = await insert(Company, { name: "Sunwise", slug: "sunwise", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  admin = await person("admin@sunwise.test", "admin");
});

describe("reading a letter to the board", () => {
  test("is one person's: it leaves their Home and bell, and the older letter comes forward", async () => {
    const august = await deliveredLetter(1, "2026-08");
    const september = await deliveredLetter(2, "2026-09");
    assert.deepEqual(await unread(owner), { number: 2, count: 2 });

    await markBoardLetterRead({ companyId: company.id, userId: owner.id, number: 2 });
    assert.deepEqual(await unread(owner), { number: 1, count: 1 });
    assert.ok((await bell(owner, september)).readAt, "the owner's bell row is read");
    assert.equal((await bell(admin, september)).readAt, null, "the admin's is not");
    assert.deepEqual(await unread(admin, "admin"), { number: 2, count: 2 });

    // Reading it again changes nothing.
    await markBoardLetterRead({ companyId: company.id, userId: owner.id, number: 2 });
    assert.deepEqual(await unread(owner), { number: 1, count: 1 });

    await markBoardLetterRead({ companyId: company.id, userId: owner.id, number: 1 });
    assert.deepEqual(await unread(owner), { number: null, count: 0 });
    assert.ok((await bell(owner, august)).readAt);
  });

  test("happens in the bell too: Home never disagrees with it", async () => {
    const august = await deliveredLetter(1, "2026-08");
    await deliveredLetter(2, "2026-09");

    await markRead({ id: (await bell(admin, august)).id, companyId: company.id, userId: admin.id });
    assert.deepEqual(await unread(admin, "admin"), { number: 2, count: 1 });

    await markAllRead({ companyId: company.id, userId: owner.id });
    assert.deepEqual(await unread(owner), { number: null, count: 0 });
  });

  test("shows a letter being audited again as it stands now", async () => {
    const letter = await deliveredLetter(1, "2026-09");
    await AppDataSource.getRepository(BoardLetter).update(letter.id, {
      status: "auditing",
      auditStatus: "pending",
    });
    const result = await listUnreadBoardLetters({
      companyId: company.id,
      userId: owner.id,
      role: "owner",
    });
    assert.equal(result.letter?.status, "auditing");
    assert.equal(result.letter?.auditStatus, "pending");
  });

  test("is not owed for a letter sent before someone joined the board", async () => {
    await deliveredLetter(1, "2026-09");
    const newcomer = await person("newcomer@sunwise.test", "admin");
    // Not sent to them, so not on their Home; What happened → Letters has it.
    assert.deepEqual(await unread(newcomer, "admin"), { number: null, count: 0 });
  });

  test("is never asked of a Member, whatever bell rows they hold", async () => {
    await deliveredLetter(1, "2026-09");
    assert.deepEqual(await unread(admin, "member"), { number: null, count: 0 });
  });

  test("keeps to the company: another company's letters never appear", async () => {
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: owner.id });
    await insert(Membership, { companyId: other.id, userId: owner.id, role: "owner" });
    await deliveredLetter(1, "2026-09", other.id);
    assert.deepEqual(await unread(owner), { number: null, count: 0 });
    await assert.rejects(
      markBoardLetterRead({ companyId: company.id, userId: owner.id, number: 1 }),
      BoardLetterNotFoundError,
    );
    assert.deepEqual(
      (await listUnreadBoardLetters({ companyId: other.id, userId: owner.id, role: "owner" }))
        .letter?.number,
      1,
    );
  });
});
