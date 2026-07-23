import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { DealStage } from "../../db/entities/DealStage.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { listActivities } from "./activities.js";
import { createContact } from "./contacts.js";
import {
  InvalidStageError,
  addDealContact,
  archiveDeal,
  createDeal,
  dealBoard,
  getDeal,
  getHydratedDeal,
  listDealContacts,
  listDeals,
  moveDealToStage,
  removeDealContact,
  updateDeal,
} from "./deals.js";
import { listDealStages } from "./stages.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_deals";
const OTHER = "co_other";

/** Seeds the default ladder and returns it keyed by name. */
async function stages(companyId = CO): Promise<Map<string, DealStage>> {
  const list = await listDealStages(companyId);
  return new Map(list.map((s) => [s.name, s]));
}

describe("stage seeding", () => {
  test("seeds the default ladder on first read, in board order", async () => {
    const list = await listDealStages(CO);
    assert.deepEqual(
      list.map((s) => s.name),
      ["New", "Qualified", "Demo", "Proposal", "Negotiation", "Closed Won", "Closed Lost"],
    );
    assert.deepEqual(
      list.map((s) => s.sortOrder),
      [0, 1, 2, 3, 4, 5, 6],
    );
  });

  test("is idempotent — reading twice does not double the ladder", async () => {
    await listDealStages(CO);
    await listDealStages(CO);
    assert.equal((await listDealStages(CO)).length, 7);
  });

  test("marks exactly one won and one lost stage", async () => {
    const list = await listDealStages(CO);
    assert.equal(list.filter((s) => s.kind === "won").length, 1);
    assert.equal(list.filter((s) => s.kind === "lost").length, 1);
    assert.equal(list.filter((s) => s.kind === "open").length, 5);
  });

  test("each company gets its own ladder", async () => {
    await listDealStages(CO);
    const theirs = await listDealStages(OTHER);
    assert.equal(theirs.length, 7);
    assert.notEqual(theirs[0].id, (await stages(CO)).get("New")?.id);
  });
});

describe("createDeal", () => {
  test("lands in the first open stage by default and is open", async () => {
    const deal = await createDeal(CO, { title: "Acme renewal", amountCents: 500_000 });
    const byName = await stages();
    assert.equal(deal.stageId, byName.get("New")?.id);
    assert.equal(deal.status, "open");
    assert.equal(deal.closedAt, null);
  });

  test("honours an explicit stage", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D", stageId: byName.get("Demo")!.id });
    assert.equal(deal.stageId, byName.get("Demo")!.id);
  });

  test("a deal created straight into a won stage is closed immediately", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "Backdated win", stageId: byName.get("Closed Won")!.id });
    assert.equal(deal.status, "won");
    assert.ok(deal.closedAt);
  });

  test("rejects a stage from another company", async () => {
    const theirs = await listDealStages(OTHER);
    await assert.rejects(
      () => createDeal(CO, { title: "X", stageId: theirs[0].id }),
      InvalidStageError,
    );
  });

  test("clamps the amount into the 32-bit money ceiling and rounds it", async () => {
    assert.equal((await createDeal(CO, { title: "a", amountCents: 9e12 })).amountCents, 2_000_000_000);
    assert.equal((await createDeal(CO, { title: "b", amountCents: -5 })).amountCents, 0);
    assert.equal((await createDeal(CO, { title: "c", amountCents: 10.6 })).amountCents, 11);
    assert.equal((await createDeal(CO, { title: "d", amountCents: Number.NaN })).amountCents, 0);
  });

  test("clamps the probability override and treats null as inherit", async () => {
    assert.equal((await createDeal(CO, { title: "a", probabilityOverride: 150 })).probabilityOverride, 100);
    assert.equal((await createDeal(CO, { title: "b", probabilityOverride: -1 })).probabilityOverride, 0);
    assert.equal((await createDeal(CO, { title: "c", probabilityOverride: null })).probabilityOverride, null);
  });

  test("defaults the currency rather than storing an empty string", async () => {
    assert.equal((await createDeal(CO, { title: "a" })).currency, "USD");
    assert.equal((await createDeal(CO, { title: "b", currency: "" })).currency, "USD");
    assert.equal((await createDeal(CO, { title: "c", currency: "GBP" })).currency, "GBP");
  });

  test("writes a deal_created activity so the timeline starts at the beginning", async () => {
    const deal = await createDeal(CO, { title: "Acme" });
    const { rows } = await listActivities(CO, { dealId: deal.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "deal_created");
    assert.equal(rows[0].subject, "Acme");
  });
});

// ─────────────── The invariant: status always mirrors stage kind ───────────────

describe("moveDealToStage — the status invariant", () => {
  test("moving to a won stage wins the deal and stamps closedAt", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    const moved = await moveDealToStage(CO, deal.id, byName.get("Closed Won")!.id);
    assert.equal(moved?.status, "won");
    assert.ok(moved?.closedAt);
  });

  test("moving to a lost stage loses it and records the reason", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    const moved = await moveDealToStage(CO, deal.id, byName.get("Closed Lost")!.id, {}, {
      lostReason: "Went with a competitor",
    });
    assert.equal(moved?.status, "lost");
    assert.ok(moved?.closedAt);
    assert.equal(moved?.lostReason, "Went with a competitor");
  });

  test("reopening clears closedAt AND the loss reason", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    await moveDealToStage(CO, deal.id, byName.get("Closed Lost")!.id, {}, {
      lostReason: "No budget",
    });
    const reopened = await moveDealToStage(CO, deal.id, byName.get("Negotiation")!.id);
    assert.equal(reopened?.status, "open");
    assert.equal(reopened?.closedAt, null);
    assert.equal(reopened?.lostReason, "");
  });

  test("re-closing does not overwrite the ORIGINAL close date", async () => {
    // Sales-cycle math reads closedAt; moving a won deal between won stages
    // must not make the cycle look shorter than it was.
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    const first = new Date("2026-03-01T00:00:00Z");
    await moveDealToStage(CO, deal.id, byName.get("Closed Won")!.id, {}, { now: first });
    const again = await moveDealToStage(CO, deal.id, byName.get("Closed Won")!.id, {}, {
      now: new Date("2026-07-01T00:00:00Z"),
    });
    assert.equal(again?.closedAt?.getTime(), first.getTime());
  });

  test("lost → won keeps the original close date, flips status, clears the reason", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    const closed = new Date("2026-03-01T00:00:00Z");
    await moveDealToStage(CO, deal.id, byName.get("Closed Lost")!.id, {}, {
      lostReason: "Lost",
      now: closed,
    });
    const won = await moveDealToStage(CO, deal.id, byName.get("Closed Won")!.id, {}, {
      now: new Date("2026-07-01T00:00:00Z"),
    });
    assert.equal(won?.status, "won");
    assert.equal(won?.lostReason, "");
    assert.equal(won?.closedAt?.getTime(), closed.getTime());
  });

  test("every move writes an activity the funnel report can read", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    await moveDealToStage(CO, deal.id, byName.get("Qualified")!.id);
    await moveDealToStage(CO, deal.id, byName.get("Demo")!.id);

    const { rows } = await listActivities(CO, { dealId: deal.id, kinds: ["stage_change"] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].subject, "Qualified → Demo");
    const meta = JSON.parse(rows[0].metaJson ?? "{}");
    assert.equal(meta.fromStage, "Qualified");
    assert.equal(meta.toStage, "Demo");
  });

  test("a win is logged as deal_won, not stage_change", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    await moveDealToStage(CO, deal.id, byName.get("Closed Won")!.id);
    const { rows } = await listActivities(CO, { dealId: deal.id, kinds: ["deal_won"] });
    assert.equal(rows.length, 1);
  });

  test("rejects a stage from another company", async () => {
    const theirs = await listDealStages(OTHER);
    const deal = await createDeal(CO, { title: "D" });
    await assert.rejects(
      () => moveDealToStage(CO, deal.id, theirs[0].id),
      InvalidStageError,
    );
  });

  test("returns null for an unknown deal instead of throwing", async () => {
    const byName = await stages();
    assert.equal(await moveDealToStage(CO, "missing", byName.get("Demo")!.id), null);
  });

  test("updateDeal routes a stage change through the invariant", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    const updated = await updateDeal(CO, deal.id, {
      stageId: byName.get("Closed Won")!.id,
      title: "D renamed",
    });
    assert.equal(updated?.status, "won");
    assert.ok(updated?.closedAt);
    assert.equal(updated?.title, "D renamed");
    // and it still logged the move
    const { rows } = await listActivities(CO, { dealId: deal.id, kinds: ["deal_won"] });
    assert.equal(rows.length, 1);
  });

  test("a status is never written directly — updateDeal cannot desync it", async () => {
    const deal = await createDeal(CO, { title: "D" });
    await updateDeal(CO, deal.id, { title: "still open", amountCents: 100 });
    const after = await getDeal(CO, deal.id);
    assert.equal(after?.status, "open");
    assert.equal(after?.closedAt, null);
  });
});

describe("hydration and the board", () => {
  test("hydrates stage, account, contact and weighted value", async () => {
    const byName = await stages();
    const contact = await createContact(CO, { name: "Ada", email: "ada@example.com" });
    const deal = await createDeal(CO, {
      title: "Acme",
      amountCents: 100_000,
      primaryContactId: contact.id,
      stageId: byName.get("Proposal")!.id, // 60%
    });
    const h = await getHydratedDeal(CO, deal.id);
    assert.equal(h?.stageName, "Proposal");
    assert.equal(h?.stageKind, "open");
    assert.equal(h?.contactName, "Ada");
    assert.equal(h?.weightedValueCents, 60_000);
  });

  test("a probability override beats the stage default", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, {
      title: "D",
      amountCents: 100_000,
      stageId: byName.get("Proposal")!.id,
      probabilityOverride: 90,
    });
    assert.equal((await getHydratedDeal(CO, deal.id))?.weightedValueCents, 90_000);
  });

  test("the board groups open deals by stage with totals, including empty columns", async () => {
    const byName = await stages();
    await createDeal(CO, { title: "A", amountCents: 100_000, stageId: byName.get("Demo")!.id });
    await createDeal(CO, { title: "B", amountCents: 200_000, stageId: byName.get("Demo")!.id });

    const board = await dealBoard(CO);
    assert.equal(board.length, 7);
    const demo = board.find((c) => c.stage.name === "Demo");
    assert.equal(demo?.deals.length, 2);
    assert.equal(demo?.totalCents, 300_000);
    assert.equal(demo?.weightedCents, 120_000); // 40% of 300k
    assert.equal(board.find((c) => c.stage.name === "New")?.deals.length, 0);
  });

  test("closed and archived deals are off the board", async () => {
    const byName = await stages();
    const won = await createDeal(CO, { title: "Won" });
    await moveDealToStage(CO, won.id, byName.get("Closed Won")!.id);
    const archived = await createDeal(CO, { title: "Archived" });
    await archiveDeal(CO, archived.id);
    await createDeal(CO, { title: "Open" });

    const board = await dealBoard(CO);
    const total = board.reduce((sum, col) => sum + col.deals.length, 0);
    assert.equal(total, 1);
  });
});

describe("listDeals", () => {
  test("filters by status, stage and owner", async () => {
    const byName = await stages();
    const won = await createDeal(CO, { title: "Won", ownerId: "u_1" });
    await moveDealToStage(CO, won.id, byName.get("Closed Won")!.id);
    await createDeal(CO, { title: "Open", ownerId: "u_2", stageId: byName.get("Demo")!.id });

    assert.equal((await listDeals(CO, { status: "won" })).total, 1);
    assert.equal((await listDeals(CO, { status: "open" })).total, 1);
    assert.equal((await listDeals(CO, { stageId: byName.get("Demo")!.id })).total, 1);
    assert.equal((await listDeals(CO, { ownerId: "u_1" })).total, 1);
  });

  test("searches title and description", async () => {
    await createDeal(CO, { title: "Acme renewal" });
    await createDeal(CO, { title: "Other", description: "renewal conversation" });
    await createDeal(CO, { title: "Unrelated" });
    assert.equal((await listDeals(CO, { q: "renewal" })).total, 2);
  });

  test("hides archived by default", async () => {
    const d = await createDeal(CO, { title: "A" });
    await archiveDeal(CO, d.id);
    assert.equal((await listDeals(CO)).total, 0);
    assert.equal((await listDeals(CO, { includeArchived: true })).total, 1);
  });

  test("never leaks another company's deals", async () => {
    await createDeal(OTHER, { title: "Theirs" });
    assert.equal((await listDeals(CO)).total, 0);
  });
});

describe("buying committee", () => {
  test("adds, lists and removes contacts", async () => {
    const deal = await createDeal(CO, { title: "D" });
    const ada = await createContact(CO, { name: "Ada", email: "ada@example.com" });
    const bob = await createContact(CO, { name: "Bob", email: "bob@example.com" });

    await addDealContact(CO, deal.id, ada.id, "Champion");
    await addDealContact(CO, deal.id, bob.id, "Economic buyer");
    const list = await listDealContacts(CO, deal.id);
    assert.deepEqual(list.map((l) => l.contact?.name), ["Ada", "Bob"]);
    assert.equal(list[0].role, "Champion");

    assert.equal(await removeDealContact(CO, deal.id, ada.id), true);
    assert.equal((await listDealContacts(CO, deal.id)).length, 1);
  });

  test("adding somebody twice updates their role instead of duplicating them", async () => {
    const deal = await createDeal(CO, { title: "D" });
    const ada = await createContact(CO, { name: "Ada", email: "ada@example.com" });
    await addDealContact(CO, deal.id, ada.id, "Champion");
    await addDealContact(CO, deal.id, ada.id, "Economic buyer");
    const list = await listDealContacts(CO, deal.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].role, "Economic buyer");
  });

  test("removing somebody who is not on the committee reports false", async () => {
    const deal = await createDeal(CO, { title: "D" });
    assert.equal(await removeDealContact(CO, deal.id, "nobody"), false);
  });
});

describe("activity denormalization", () => {
  test("a stage move refreshes the deal's lastActivityAt", async () => {
    const byName = await stages();
    const deal = await createDeal(CO, { title: "D" });
    const later = new Date(Date.now() + 60_000);
    await moveDealToStage(CO, deal.id, byName.get("Demo")!.id, {}, { now: later });
    const after = await getDeal(CO, deal.id);
    assert.equal(after?.lastActivityAt?.getTime(), later.getTime());
  });

  test("activities carry the contact and customer through from the deal", async () => {
    const contact = await createContact(CO, { name: "Ada", email: "ada@example.com" });
    const deal = await createDeal(CO, { title: "D", primaryContactId: contact.id });
    const rows = await AppDataSource.getRepository(Activity).findBy({ dealId: deal.id });
    assert.equal(rows[0].contactId, contact.id);
  });
});
