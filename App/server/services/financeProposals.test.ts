import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import {
  applyFinanceProposal,
  createJournalEntryProposal,
  getFinanceProposal,
  listFinanceProposals,
  rejectFinanceProposal,
  type ProposalActor,
} from "./financeProposals.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_proposals";
const MAKER: ProposalActor = { type: "human", id: "u_maker", label: "Maker" };

async function setup() {
  await seedChartOfAccounts(CO);
  const cash = (await accountByCode(CO, "1100"))!;
  const expense = (await accountByCode(CO, "6000"))!;
  return { cash, expense };
}

function balancedPayload(expenseId: string, cashId: string, cents = 5000) {
  return {
    date: "2026-05-01",
    memo: "Office supplies",
    lines: [
      { accountId: expenseId, debitCents: cents, creditCents: 0 },
      { accountId: cashId, debitCents: 0, creditCents: cents },
    ],
  };
}

async function entryCount(): Promise<number> {
  return AppDataSource.getRepository(LedgerEntry).countBy({ companyId: CO });
}

describe("createJournalEntryProposal", () => {
  test("stages a pending proposal without touching the ledger", async () => {
    const { cash, expense } = await setup();
    const before = await entryCount();
    const p = await createJournalEntryProposal(CO, balancedPayload(expense.id, cash.id), MAKER);
    assert.equal(p.status, "pending");
    assert.equal(p.kind, "journal_entry");
    assert.equal(p.proposedByType, "human");
    assert.equal(p.proposedByLabel, "Maker");
    assert.equal(p.appliedEntryId, null);
    assert.equal(await entryCount(), before, "nothing should post at create time");
  });

  test("rejects an unbalanced payload", async () => {
    const { cash, expense } = await setup();
    await assert.rejects(
      () =>
        createJournalEntryProposal(
          CO,
          {
            date: "2026-05-01",
            memo: "bad",
            lines: [
              { accountId: expense.id, debitCents: 5000, creditCents: 0 },
              { accountId: cash.id, debitCents: 0, creditCents: 4000 },
            ],
          },
          MAKER,
        ),
      /unbalanced/i,
    );
  });

  test("rejects a line with both debit and credit set", async () => {
    const { cash, expense } = await setup();
    await assert.rejects(
      () =>
        createJournalEntryProposal(
          CO,
          {
            date: "2026-05-01",
            memo: "bad",
            lines: [
              { accountId: expense.id, debitCents: 5000, creditCents: 5000 },
              { accountId: cash.id, debitCents: 0, creditCents: 5000 },
            ],
          },
          MAKER,
        ),
      /exactly one of debit or credit/i,
    );
  });
});

describe("applyFinanceProposal", () => {
  test("posts a balanced, tagged entry and links it back", async () => {
    const { cash, expense } = await setup();
    const p = await createJournalEntryProposal(CO, balancedPayload(expense.id, cash.id), MAKER);
    const applied = await applyFinanceProposal(p, { userId: "u_checker", note: "looks right" });

    assert.equal(applied.status, "applied");
    assert.ok(applied.appliedEntryId);
    assert.equal(applied.decidedByUserId, "u_checker");
    assert.equal(applied.reviewNote, "looks right");

    const entry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
      id: applied.appliedEntryId!,
    });
    assert.ok(entry, "an entry was posted");
    assert.equal(entry!.source, "manual");
    assert.equal(entry!.sourceRefId, `finance_proposal:${p.id}`);

    const lines = await AppDataSource.getRepository(LedgerLine).find({
      where: { ledgerEntryId: entry!.id },
    });
    const debit = lines.reduce((s, l) => s + l.debitCents, 0);
    const credit = lines.reduce((s, l) => s + l.creditCents, 0);
    assert.equal(debit, credit);
    assert.equal(debit, 5000);
    assert.equal(lines.find((l) => l.accountId === expense.id)!.debitCents, 5000);
    assert.equal(lines.find((l) => l.accountId === cash.id)!.creditCents, 5000);
  });

  test("refuses to apply a proposal that is not pending", async () => {
    const { cash, expense } = await setup();
    const p = await createJournalEntryProposal(CO, balancedPayload(expense.id, cash.id), MAKER);
    const applied = await applyFinanceProposal(p, { userId: "u_checker" });
    await assert.rejects(
      () => applyFinanceProposal(applied, { userId: "u_checker" }),
      /already applied/i,
    );
  });

  test("a failed apply leaves the proposal pending with the reason recorded", async () => {
    const { cash } = await setup();
    // A well-formed payload (balances, valid uuid) whose debit account does not
    // exist — apply reaches postLedgerEntry, which rejects it.
    const p = await createJournalEntryProposal(
      CO,
      {
        date: "2026-05-01",
        memo: "ghost account",
        lines: [
          { accountId: "00000000-0000-4000-8000-000000000000", debitCents: 1000, creditCents: 0 },
          { accountId: cash.id, debitCents: 0, creditCents: 1000 },
        ],
      },
      MAKER,
    );
    await assert.rejects(
      () => applyFinanceProposal(p, { userId: "u_checker" }),
      /accounts are missing/i,
    );
    const reloaded = await getFinanceProposal(CO, p.id);
    assert.equal(reloaded!.status, "pending", "stays pending so it can be fixed and retried");
    assert.ok(reloaded!.errorMessage, "the failure reason is surfaced");
    assert.equal(reloaded!.appliedEntryId, null);
  });
});

describe("rejectFinanceProposal + listing", () => {
  test("reject marks it rejected and posts nothing", async () => {
    const { cash, expense } = await setup();
    const before = await entryCount();
    const p = await createJournalEntryProposal(CO, balancedPayload(expense.id, cash.id), MAKER);
    const rejected = await rejectFinanceProposal(p, { userId: "u_checker", note: "duplicate" });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.reviewNote, "duplicate");
    assert.equal(await entryCount(), before);
    await assert.rejects(
      () => applyFinanceProposal(rejected, { userId: "u_checker" }),
      /already rejected/i,
    );
  });

  test("listing filters by status", async () => {
    const { cash, expense } = await setup();
    const a = await createJournalEntryProposal(CO, balancedPayload(expense.id, cash.id), MAKER);
    await createJournalEntryProposal(CO, balancedPayload(expense.id, cash.id), MAKER);
    await applyFinanceProposal(a, { userId: "u_checker" });

    const pending = await listFinanceProposals(CO, { status: "pending" });
    assert.ok(pending.length >= 1);
    assert.ok(pending.every((p) => p.status === "pending"));

    const applied = await listFinanceProposals(CO, { status: "applied" });
    assert.ok(applied.every((p) => p.status === "applied"));

    const all = await listFinanceProposals(CO);
    assert.ok(all.length >= pending.length + applied.length);
  });
});
